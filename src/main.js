// Cirrus main process: owns the window, settings, and the claude CLI child processes.
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const http = require('http');
const crypto = require('crypto');

const IS_WIN = process.platform === 'win32';
let win = null;

// ---------- settings ----------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = {
  claudePath: '',
  cwd: os.homedir(),
  model: '',
  permissionMode: 'manual',
  authMode: 'token', // 'token' = long-lived OAuth token, 'login' = full `claude auth login`
  tokenEnc: '',
  rcName: '',
  rcKey: '',
  remoteOn: false,
};
let settings = { ...DEFAULTS };

function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch {}
}
function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

function storedToken() {
  if (!settings.tokenEnc) return '';
  try {
    const buf = Buffer.from(settings.tokenEnc, 'base64');
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch { return ''; }
}
function setStoredToken(tok) {
  if (!tok) { settings.tokenEnc = ''; return; }
  const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(tok) : Buffer.from(tok, 'utf8');
  settings.tokenEnc = buf.toString('base64');
}

// ---------- environment ----------

// Apps opened from a menu don't see the shell's PATH or exports, so ask a login shell once.
let shellEnv = null;
function loadShellEnv() {
  if (shellEnv) return Promise.resolve(shellEnv);
  if (IS_WIN) return Promise.resolve(shellEnv = {});
  const sh = process.env.SHELL || '/bin/bash';
  const script = 'printf "\\n__CIRRUS_PATH__%s\\n__CIRRUS_TOKEN__%s\\n" "$PATH" "$CLAUDE_CODE_OAUTH_TOKEN"';
  return new Promise((resolve) => {
    execFile(sh, ['-ilc', script], { timeout: 10000, env: { ...process.env, TERM: 'dumb' } }, (_err, stdout = '') => {
      const pick = (k) => (stdout.match(new RegExp(`__CIRRUS_${k}__(.*)`)) || [])[1] || '';
      resolve(shellEnv = { PATH: pick('PATH'), CLAUDE_CODE_OAUTH_TOKEN: pick('TOKEN') });
    });
  });
}

function currentToken() {
  return storedToken() || process.env.CLAUDE_CODE_OAUTH_TOKEN || shellEnv?.CLAUDE_CODE_OAUTH_TOKEN || '';
}

// Strip every CLAUDE_*/ANTHROPIC_* variable we inherited so only the chosen login is used.
function childEnv({ withToken }) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC)/i.test(k)) continue;
    env[k] = v;
  }
  if (shellEnv?.PATH) env.PATH = shellEnv.PATH;
  if (withToken) {
    const tok = currentToken();
    if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok;
  }
  env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli';
  return env;
}

function findClaude() {
  if (settings.claudePath && fs.existsSync(settings.claudePath)) return settings.claudePath;
  const home = os.homedir();
  const names = IS_WIN ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const dirs = [
    ...((shellEnv?.PATH || process.env.PATH || '').split(path.delimiter)),
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    IS_WIN ? path.join(process.env.APPDATA || '', 'npm') : '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  for (const d of dirs) for (const n of names) {
    const p = path.join(d, n);
    if (d && fs.existsSync(p)) return p;
  }
  return '';
}

function spawnClaude(args, opts) {
  const bin = findClaude();
  if (!bin) throw new Error('Could not find the claude CLI. Install Claude Code, or set its path in Settings.');
  const useShell = IS_WIN && /\.(cmd|bat)$/i.test(bin);
  return spawn(useShell ? `"${bin}"` : bin, args, { ...opts, shell: useShell, windowsHide: true });
}

// Deliver an event to the desktop window and to every connected phone.
const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  if (sseClients.size) {
    const line = `data: ${JSON.stringify({ channel, payload })}\n\n`;
    for (const c of sseClients) c.write(line);
  }
};
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');

// ---------- chat sessions ----------

class Session {
  constructor(sid, { resume, cwd, model, permissionMode }) {
    this.sid = sid;
    this.reqN = 0;
    this.claudeId = resume || null;
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', permissionMode || 'manual'];
    if (model) args.push('--model', model);
    if (resume) args.push('--resume', resume);
    this.proc = spawnClaude(args, { cwd, env: childEnv({ withToken: settings.authMode === 'token' }) });
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return send('cc:event', { sid, msg: { type: 'raw', text: line } }); }
      // Only permission prompts are answered by the UI; refuse anything else so the CLI never waits forever.
      if (msg.type === 'control_request' && msg.request?.subtype !== 'can_use_tool') {
        this.write({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `Unsupported by Cirrus: ${msg.request?.subtype}` } });
        return;
      }
      if (msg.type === 'system' && msg.subtype === 'init') this.claudeId = msg.session_id;
      send('cc:event', { sid, msg });
    });
    this.proc.stderr.on('data', (d) => send('cc:event', { sid, msg: { type: 'stderr', text: stripAnsi(d.toString()) } }));
    this.proc.on('error', (e) => send('cc:event', { sid, msg: { type: 'stderr', text: e.message } }));
    this.proc.on('exit', (code) => { sessions.delete(sid); send('cc:event', { sid, msg: { type: 'exit', code } }); });
    this.control({ subtype: 'initialize' });
  }
  write(obj) { if (this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(obj) + '\n'); }
  control(request) { this.write({ type: 'control_request', request_id: `cirrus-${++this.reqN}`, request }); }
  user(content) { this.write({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }); }
  answer(requestId, response) {
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  }
  kill() { try { this.proc.kill(); } catch {} }
}
const sessions = new Map();

// ---------- saved conversations ----------

const projectDir = (cwd) => path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  return '';
}

function listConversations(cwd) {
  const dir = projectDir(cwd);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  return files.map((f) => {
    const full = path.join(dir, f);
    const stat = fs.statSync(full);
    let title = '';
    try {
      const fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(Math.min(stat.size, 256 * 1024));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      for (const line of buf.toString('utf8').split('\n')) {
        try {
          const o = JSON.parse(line);
          if (o.type === 'summary' && o.summary) { title = o.summary; break; }
          if (!title && o.type === 'user' && !o.isMeta) {
            const t = textOf(o.message?.content).trim();
            if (t && !t.startsWith('<')) title = t;
          }
        } catch {}
      }
    } catch {}
    return { id: f.replace(/\.jsonl$/, ''), title: (title || 'Untitled chat').slice(0, 90), mtime: stat.mtimeMs };
  }).sort((a, b) => b.mtime - a.mtime).slice(0, 200);
}

function loadConversation(cwd, id) {
  const file = path.join(projectDir(cwd), `${id}.jsonl`);
  const out = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      try {
        const o = JSON.parse(line);
        if ((o.type === 'user' || o.type === 'assistant') && !o.isMeta && !o.isSidechain && o.message) {
          out.push({ type: o.type, message: o.message });
        }
      } catch {}
    }
  } catch {}
  return out;
}

// ---------- remote control & login ----------

let rcProc = null;
function startRemoteControl() {
  if (rcProc) return;
  const args = ['remote-control'];
  if (settings.rcName) args.push('--name', settings.rcName);
  // Remote Control needs a full login, never the inference-only token.
  rcProc = spawnClaude(args, { cwd: settings.cwd, env: childEnv({ withToken: false }) });
  send('rc:status', { running: true });
  const out = (d) => send('rc:output', stripAnsi(d.toString()));
  rcProc.stdout.on('data', out);
  rcProc.stderr.on('data', out);
  rcProc.on('error', (e) => out(e.message));
  rcProc.on('exit', (code) => { rcProc = null; send('rc:status', { running: false, code }); });
}
function stopRemoteControl() { if (rcProc) { try { rcProc.kill(); } catch {} } }

let loginProc = null;
function startLogin() {
  if (loginProc) return;
  loginProc = spawnClaude(['auth', 'login', '--claudeai'], { cwd: os.homedir(), env: childEnv({ withToken: false }) });
  const out = (d) => send('login:output', stripAnsi(d.toString()));
  loginProc.stdout.on('data', out);
  loginProc.stderr.on('data', out);
  loginProc.on('error', (e) => out(e.message));
  loginProc.on('exit', (code) => { loginProc = null; send('login:done', { code }); });
}

function authStatus() {
  return new Promise((resolve) => {
    let p;
    try { p = spawnClaude(['auth', 'status'], { env: childEnv({ withToken: false }) }); } catch (e) { return resolve({ error: e.message }); }
    let s = '';
    p.stdout.on('data', (d) => (s += d));
    p.on('error', (e) => resolve({ error: e.message }));
    p.on('exit', () => { try { resolve(JSON.parse(s)); } catch { resolve({ loggedIn: false }); } });
  });
}

// ---------- actions (shared by the desktop window and phone clients) ----------

const actions = {};
const remoteOk = new Set();
function expose(name, fn, { remote = false } = {}) {
  actions[name] = fn;
  if (remote) remoteOk.add(name);
  ipcMain.handle(name, (_e, ...args) => fn(...args));
}

async function publicSettings() {
  await loadShellEnv();
  const { tokenEnc, rcKey, ...rest } = settings;
  const tok = currentToken();
  return { ...rest, hasToken: !!tok, tokenSource: storedToken() ? 'saved' : tok ? 'environment' : 'none', claudeFound: findClaude(), platform: process.platform };
}

expose('settings:get', publicSettings, { remote: true });
expose('settings:set', (patch) => {
  if ('token' in patch) { setStoredToken(String(patch.token || '').trim()); delete patch.token; }
  delete patch.rcKey;
  Object.assign(settings, patch);
  saveSettings();
  return true;
});
// Phones may only change the model and permission mode.
expose('settings:setChat', (patch) => {
  for (const k of ['model', 'permissionMode']) if (k in patch) settings[k] = String(patch[k] || '');
  saveSettings();
  return true;
}, { remote: true });
expose('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: settings.cwd });
  return r.canceled ? null : r.filePaths[0];
});
expose('conv:list', () => listConversations(settings.cwd), { remote: true });
expose('conv:load', (_cwd, id) => loadConversation(settings.cwd, String(id)), { remote: true });

expose('cc:start', async (sid, opts = {}) => {
  await loadShellEnv();
  sessions.get(sid)?.kill();
  try {
    const { resume, model, permissionMode } = opts;
    sessions.set(sid, new Session(sid, {
      cwd: settings.cwd,
      resume: resume || undefined,
      model: model ?? settings.model,
      permissionMode: permissionMode || settings.permissionMode,
    }));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}, { remote: true });
expose('cc:send', (sid, content) => {
  const s = sessions.get(sid);
  if (!s) return false;
  s.user(content);
  // Every window and phone shows the message, not just the one that sent it.
  send('cc:event', { sid, msg: { type: 'cirrus_user', message: { role: 'user', content } } });
  return true;
}, { remote: true });
expose('cc:interrupt', (sid) => { sessions.get(sid)?.control({ subtype: 'interrupt' }); }, { remote: true });
expose('cc:permission', (sid, requestId, response) => {
  sessions.get(sid)?.answer(requestId, response);
  send('cc:event', { sid, msg: { type: 'cirrus_perm_answered', request_id: requestId, behavior: response?.behavior } });
}, { remote: true });
expose('cc:setMode', (sid, mode) => { sessions.get(sid)?.control({ subtype: 'set_permission_mode', mode }); }, { remote: true });
expose('cc:setModel', (sid, model) => { sessions.get(sid)?.control({ subtype: 'set_model', model: model || undefined }); }, { remote: true });
expose('cc:stop', (sid) => { sessions.get(sid)?.kill(); }, { remote: true });
expose('cc:state', (sid) => {
  const s = sessions.get(sid);
  return { running: !!s, sessionId: s?.claudeId || null, active: activeChat.get(sid) ?? null };
}, { remote: true });
// A client switched chats: tell the others so they follow.
const activeChat = new Map();
expose('cc:announce', (sid, info) => {
  activeChat.set(sid, info?.sessionId ?? null);
  send('cc:event', { sid, msg: { type: 'cirrus_active', sessionId: info?.sessionId ?? null, origin: info?.origin } });
}, { remote: true });

expose('rc:start', async () => { await loadShellEnv(); try { startRemoteControl(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
expose('rc:stop', () => stopRemoteControl());
expose('rc:running', () => !!rcProc);
expose('auth:status', async () => { await loadShellEnv(); return authStatus(); }, { remote: true });
expose('auth:login', async () => { await loadShellEnv(); try { startLogin(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
expose('auth:loginInput', (text) => { loginProc?.stdin.write(text + '\n'); });
expose('auth:logout', async () => {
  await loadShellEnv();
  return new Promise((resolve) => {
    try { spawnClaude(['auth', 'logout'], { env: childEnv({ withToken: false }) }).on('exit', () => resolve(true)); } catch { resolve(false); }
  });
});
expose('open:external', (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });

// ---------- Cirrus Remote: serve the chat to phones ----------

const ROOT = path.join(__dirname, '..');
const STATIC = {
  '/src/renderer/index.html': 'text/html; charset=utf-8',
  '/src/renderer/style.css': 'text/css; charset=utf-8',
  '/src/renderer/app.js': 'text/javascript; charset=utf-8',
  '/src/renderer/remote-shim.js': 'text/javascript; charset=utf-8',
  '/build/icon.png': 'image/png',
  '/node_modules/marked/lib/marked.umd.js': 'text/javascript; charset=utf-8',
  '/node_modules/dompurify/dist/purify.min.js': 'text/javascript; charset=utf-8',
};
const REMOTE_PORT = 8787;
let remoteServer = null;
let remotePort = 0;
const sseClients = new Set();

function remoteKey() {
  if (!settings.rcKey) { settings.rcKey = crypto.randomBytes(24).toString('base64url'); saveSettings(); }
  return settings.rcKey;
}
function keyOk(k) {
  const a = Buffer.from(String(k || '')), b = Buffer.from(remoteKey());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function remoteAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const tailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address) || /tailscale/i.test(name);
      out.push({ ip: a.address, kind: tailscale ? 'Tailscale (works anywhere)' : 'Same Wi-Fi' });
    }
  }
  return out.sort((x, y) => (x.kind < y.kind ? 1 : -1));
}

async function remoteInfo() {
  if (!remoteServer) return { running: false };
  const QR = require('qrcode');
  const links = await Promise.all(remoteAddresses().map(async (a) => {
    const url = `http://${a.ip}:${remotePort}/?k=${remoteKey()}`;
    return { ...a, url, qr: await QR.toDataURL(url, { margin: 1, width: 220 }) };
  }));
  return { running: true, port: remotePort, links, clients: sseClients.size };
}

function handleRemote(req, res) {
  const u = new URL(req.url, 'http://x');
  const deny = (code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(msg); };
  if (req.method === 'GET' && u.pathname === '/') {
    res.writeHead(302, { Location: `/src/renderer/index.html${u.search}` });
    return res.end();
  }
  if (req.method === 'GET' && STATIC[u.pathname]) {
    return fs.readFile(path.join(ROOT, u.pathname), (err, data) => {
      if (err) return deny(404, 'Not found');
      res.writeHead(200, { 'Content-Type': STATIC[u.pathname], 'Cache-Control': 'no-store' });
      res.end(data);
    });
  }
  if (!u.pathname.startsWith('/api/')) return deny(404, 'Not found');
  if (!keyOk(u.searchParams.get('k') || req.headers['x-cirrus-key'])) return deny(401, 'Bad or old link. Open the new one from Cirrus on your computer.');

  if (req.method === 'GET' && u.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': hi\n\n');
    sseClients.add(res);
    send('remote:clients', sseClients.size);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); send('remote:clients', sseClients.size); });
    return;
  }
  if (req.method === 'POST' && u.pathname === '/api/call') {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 30e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const { name, args = [] } = JSON.parse(body || '{}');
        if (!remoteOk.has(name)) return deny(403, 'Not allowed from a phone');
        const result = await actions[name](...args);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: result ?? null }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  deny(404, 'Not found');
}

function startRemote() {
  if (remoteServer) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handleRemote);
    const listen = (port) => srv.listen(port, '0.0.0.0');
    srv.on('error', (e) => { if (e.code === 'EADDRINUSE' && !srv._retried) { srv._retried = true; listen(0); } else reject(e); });
    srv.on('listening', () => { remoteServer = srv; remotePort = srv.address().port; settings.remoteOn = true; saveSettings(); resolve(); });
    listen(REMOTE_PORT);
  });
}
function stopRemote() {
  for (const c of sseClients) { try { c.end(); } catch {} }
  sseClients.clear();
  remoteServer?.close();
  remoteServer = null;
  settings.remoteOn = false;
  saveSettings();
}

expose('remote:start', async () => { try { await startRemote(); return { ok: true, ...(await remoteInfo()) }; } catch (e) { return { ok: false, error: e.message }; } });
expose('remote:stop', () => { stopRemote(); return { running: false }; });
expose('remote:info', remoteInfo);
expose('remote:newKey', async () => {
  settings.rcKey = '';
  remoteKey();
  for (const c of sseClients) { try { c.end(); } catch {} }
  sseClients.clear();
  return remoteInfo();
});

// ---------- window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 760, minHeight: 520,
    backgroundColor: '#14151a', title: 'Cirrus', autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  loadSettings();
  loadShellEnv();
  createWindow();
  if (settings.remoteOn) startRemote().catch(() => {});
});
app.on('window-all-closed', () => {
  for (const s of sessions.values()) s.kill();
  stopRemoteControl();
  remoteServer?.close();
  app.quit();
});
