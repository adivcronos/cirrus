// Cirrus main process: owns the window, settings, and the claude CLI child processes.
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');

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

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');

// ---------- chat sessions ----------

class Session {
  constructor(sid, { resume, cwd, model, permissionMode }) {
    this.sid = sid;
    this.reqN = 0;
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

// ---------- IPC ----------

ipcMain.handle('settings:get', async () => {
  await loadShellEnv();
  const { tokenEnc, ...rest } = settings;
  const tok = currentToken();
  return { ...rest, hasToken: !!tok, tokenSource: storedToken() ? 'saved' : tok ? 'environment' : 'none', claudeFound: findClaude(), platform: process.platform };
});
ipcMain.handle('settings:set', (_e, patch) => {
  if ('token' in patch) { setStoredToken(String(patch.token || '').trim()); delete patch.token; }
  Object.assign(settings, patch);
  saveSettings();
  return true;
});
ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: settings.cwd });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('conv:list', (_e, cwd) => listConversations(cwd || settings.cwd));
ipcMain.handle('conv:load', (_e, cwd, id) => loadConversation(cwd || settings.cwd, id));

ipcMain.handle('cc:start', async (_e, sid, opts) => {
  await loadShellEnv();
  sessions.get(sid)?.kill();
  try {
    sessions.set(sid, new Session(sid, { cwd: settings.cwd, model: settings.model, permissionMode: settings.permissionMode, ...opts }));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('cc:send', (_e, sid, content) => { sessions.get(sid)?.user(content); return !!sessions.get(sid); });
ipcMain.handle('cc:interrupt', (_e, sid) => { sessions.get(sid)?.control({ subtype: 'interrupt' }); });
ipcMain.handle('cc:permission', (_e, sid, requestId, response) => { sessions.get(sid)?.answer(requestId, response); });
ipcMain.handle('cc:setMode', (_e, sid, mode) => { sessions.get(sid)?.control({ subtype: 'set_permission_mode', mode }); });
ipcMain.handle('cc:setModel', (_e, sid, model) => { sessions.get(sid)?.control({ subtype: 'set_model', model: model || undefined }); });
ipcMain.handle('cc:stop', (_e, sid) => { sessions.get(sid)?.kill(); });

ipcMain.handle('rc:start', async () => { await loadShellEnv(); try { startRemoteControl(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('rc:stop', () => stopRemoteControl());
ipcMain.handle('rc:running', () => !!rcProc);
ipcMain.handle('auth:status', async () => { await loadShellEnv(); return authStatus(); });
ipcMain.handle('auth:login', async () => { await loadShellEnv(); try { startLogin(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('auth:loginInput', (_e, text) => { loginProc?.stdin.write(text + '\n'); });
ipcMain.handle('auth:logout', async () => {
  await loadShellEnv();
  return new Promise((resolve) => {
    try { spawnClaude(['auth', 'logout'], { env: childEnv({ withToken: false }) }).on('exit', () => resolve(true)); } catch { resolve(false); }
  });
});
ipcMain.handle('open:external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });

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

app.whenReady().then(() => { loadSettings(); loadShellEnv(); createWindow(); });
app.on('window-all-closed', () => {
  for (const s of sessions.values()) s.kill();
  stopRemoteControl();
  app.quit();
});
