// Cirrus UI: renders the claude CLI's stream-json events as a chat.
const $ = (id) => document.getElementById(id);
const api = window.cirrus;
const SID = 'main';
const ORIGIN = Math.random().toString(36).slice(2);
const REMOTE = !!window.CIRRUS_REMOTE;

let settings = {};
let claudeSessionId = null; // the CLI's own session id, used to resume
let running = false;        // CLI process alive
let busy = false;           // a turn is in progress
let attachments = [];
let stderrBuf = '';

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = (s) => esc(s).replace(/https?:\/\/[^\s<>"')]+/g, (u) => `<a href="#" data-href="${u}">${u}</a>`);
const baseName = (p) => (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      return `<div class="codeblock"><button class="copy">Copy</button><pre><code class="lang-${esc(lang || '')}">${esc(text)}</code></pre></div>`;
    },
  },
});
const md = (s) => DOMPurify.sanitize(marked.parse(s || ''));

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

const scroller = $('scroller');
const messages = $('messages');
let stick = true;
scroller.addEventListener('scroll', () => {
  stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
});
function append(node) {
  $('empty')?.remove();
  messages.appendChild(node);
  if (stick) requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight));
  return node;
}
function notice(text, err) { return append(el('div', 'notice' + (err ? ' err' : ''), linkify(text))); }

function setBusy(b) {
  busy = b;
  $('sendBtn').classList.toggle('busy', b);
  $('sendBtn').title = b ? 'Stop (Esc)' : 'Send';
}

function resetView() {
  messages.innerHTML = '';
  const empty = el('div', 'empty');
  empty.id = 'empty';
  empty.innerHTML = `<div class="empty-mark"></div><h1>What are we building?</h1>
    <p>Claude Code runs underneath, in <code>${esc(settings.cwd)}</code>.</p>`;
  messages.appendChild(empty);
  containers.clear();
  toolRows.clear();
  liveTexts = [];
}

// ---------- assistant rendering ----------

const containers = new Map(); // message id -> { node, texts:Set, tools:Set }
const toolRows = new Map();   // tool_use id -> row element
let liveTexts = [];           // streaming text nodes waiting for their final block
let currentMsgId = null;

function containerFor(id) {
  if (id && containers.has(id)) return containers.get(id);
  const c = { node: append(el('div', 'msg assistant')), texts: new Set(), tools: new Set() };
  if (id) containers.set(id, c);
  return c;
}

function toolSummary(name, input = {}) {
  const pick = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt;
  if (name === 'TodoWrite' && Array.isArray(input.todos)) return `${input.todos.length} items`;
  if (pick != null) return String(pick).split('\n')[0];
  const first = Object.values(input).find((v) => typeof v === 'string');
  return first ? first.split('\n')[0] : '';
}

function toolRow(block) {
  const row = el('div', 'tool');
  const head = el('button', 'tool-head',
    `<svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
     <span class="tool-name">${esc(block.name)}</span>
     <span class="tool-sum">${esc(toolSummary(block.name, block.input))}</span>
     <span class="tool-state"></span>`);
  head.onclick = () => row.classList.toggle('open');
  const body = el('div', 'tool-body');
  const inner = el('div');
  if (block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) {
    const ul = el('ul', 'todo');
    for (const t of block.input.todos) {
      const mark = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '○';
      ul.appendChild(el('li', t.status, `<span>${mark}</span><span>${esc(t.content || t.activeForm || '')}</span>`));
    }
    inner.appendChild(ul);
  } else if (block.name === 'Bash' && block.input?.command) {
    inner.appendChild(el('pre', null, esc(block.input.command)));
  } else if (block.name === 'Edit' && block.input) {
    inner.appendChild(el('pre', null, esc(`${block.input.file_path}\n\n− ${block.input.old_string ?? ''}\n\n+ ${block.input.new_string ?? ''}`)));
  } else {
    inner.appendChild(el('pre', null, esc(JSON.stringify(block.input ?? {}, null, 2))));
  }
  body.appendChild(inner);
  row.append(head, body);
  row._inner = inner;
  toolRows.set(block.id, row);
  return row;
}

function toolResult(block) {
  const row = toolRows.get(block.tool_use_id);
  if (!row) return;
  let text = '';
  if (typeof block.content === 'string') text = block.content;
  else if (Array.isArray(block.content)) text = block.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  if (text) row._inner.appendChild(el('pre', null, esc(text.length > 20000 ? text.slice(0, 20000) + '\n…' : text)));
  row.classList.add(block.is_error ? 'failed' : 'done');
}

function renderAssistant(message) {
  const c = containerFor(message.id);
  for (const b of message.content || []) {
    if (b.type === 'text') {
      if (c.texts.has(b.text)) continue;
      c.texts.add(b.text);
      const live = liveTexts.shift();
      const node = live || c.node.appendChild(el('div', 'prose'));
      node.classList.remove('caret');
      node.innerHTML = md(b.text);
    } else if (b.type === 'thinking' && b.thinking) {
      if (c.texts.has(b.thinking)) continue;
      c.texts.add(b.thinking);
      const row = el('div', 'tool');
      row.innerHTML = `<button class="tool-head"><svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg><span class="thinking">Thinking</span></button>
        <div class="tool-body"><div><pre>${esc(b.thinking)}</pre></div></div>`;
      row.firstChild.onclick = () => row.classList.toggle('open');
      c.node.appendChild(row);
    } else if (b.type === 'tool_use') {
      if (c.tools.has(b.id)) continue;
      c.tools.add(b.id);
      c.node.appendChild(toolRow(b));
    }
  }
  if (stick) scroller.scrollTop = scroller.scrollHeight;
}

function renderUser(message, { live } = {}) {
  const content = message.content;
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content || [];
  const bubble = el('div', 'bubble');
  let show = false;
  for (const b of blocks) {
    if (b.type === 'tool_result') { toolResult(b); continue; }
    if (b.type === 'image' && b.source?.data) {
      const img = el('img');
      img.src = `data:${b.source.media_type};base64,${b.source.data}`;
      bubble.appendChild(img);
      show = true;
    } else if (b.type === 'text' && b.text) {
      let t = b.text;
      const cmd = t.match(/<command-name>(.*?)<\/command-name>/);
      if (cmd) t = cmd[1];
      else if (/^\s*<(local-command|system-reminder|command-)/.test(t)) continue;
      bubble.appendChild(document.createTextNode(t));
      show = true;
    }
  }
  if (show) {
    const wrap = el('div', 'msg user');
    wrap.appendChild(bubble);
    append(wrap);
    if (live) stick = true;
  }
}

let rafPending = false;
function onStreamEvent(ev) {
  if (ev.type === 'message_start') currentMsgId = ev.message?.id;
  else if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') {
    const c = containerFor(currentMsgId);
    const node = c.node.appendChild(el('div', 'prose caret'));
    node._raw = '';
    liveTexts.push(node);
  } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
    const node = liveTexts[liveTexts.length - 1];
    if (!node) return;
    node._raw += ev.delta.text;
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        for (const n of liveTexts) n.innerHTML = md(n._raw);
        if (stick) scroller.scrollTop = scroller.scrollHeight;
      });
    }
  }
}

// ---------- permission prompts ----------

function permissionCard(reqId, req) {
  const input = req.input || {};
  let detail = toolSummary(req.tool_name, input);
  if (req.tool_name === 'Edit' || req.tool_name === 'Write') detail = input.file_path;
  if (req.tool_name === 'Bash') detail = input.command;
  const card = el('div', 'perm');
  card.dataset.rid = reqId;
  card._tool = req.tool_name;
  card.innerHTML = `<div class="perm-title">Claude wants to use ${esc(req.tool_name)}</div>
    ${req.decision_reason || input.description ? `<div class="muted" style="margin-bottom:6px">${esc(input.description || req.decision_reason)}</div>` : ''}
    <pre>${esc(detail || JSON.stringify(input, null, 2))}</pre>
    <div class="row">
      <button class="btn primary" data-a="allow">Allow</button>
      ${req.permission_suggestions?.length ? '<button class="btn" data-a="always">Always allow</button>' : ''}
      <button class="btn ghost danger" data-a="deny">Deny</button>
    </div>`;
  card.querySelectorAll('button').forEach((b) => (b.onclick = () => {
    const a = b.dataset.a;
    let resp;
    if (a === 'deny') resp = { behavior: 'deny', message: 'The user denied this action.' };
    else resp = { behavior: 'allow', updatedInput: input, ...(a === 'always' ? { updatedPermissions: req.permission_suggestions } : {}) };
    api.answerPermission(SID, reqId, resp);
    resolvePerm(reqId, resp.behavior);
  }));
  append(card);
}

function resolvePerm(reqId, behavior) {
  const card = messages.querySelector(`.perm[data-rid="${CSS.escape(reqId)}"]`);
  if (!card || card.classList.contains('resolved')) return;
  card.classList.add('resolved');
  card.querySelector('.perm-title').textContent = `${behavior === 'deny' ? 'Denied' : 'Allowed'}: ${card._tool}`;
}

// ---------- CLI events ----------

api.onEvent(({ sid, msg }) => {
  if (sid !== SID) return;
  if (msg.type !== 'exit' && msg.type !== 'cirrus_active') running = true;
  switch (msg.type) {
    case 'cirrus_user':
      renderUser(msg.message, { live: true });
      setBusy(true);
      break;
    case 'cirrus_perm_answered':
      resolvePerm(msg.request_id, msg.behavior);
      break;
    case 'cirrus_active':
      // Another screen switched chats; follow it without stopping anything.
      if (msg.origin === ORIGIN || msg.sessionId === claudeSessionId) break;
      if (msg.sessionId) showConversation(msg.sessionId);
      else { claudeSessionId = null; running = false; setBusy(false); resetView(); refreshConversations(); }
      break;
    case 'system':
      if (msg.subtype === 'init') {
        claudeSessionId = msg.session_id;
        const pill = $('statusPill');
        pill.textContent = `${msg.model || ''} · ${settings.authMode === 'token' ? 'OAuth token' : 'full login'}`;
        pill.classList.remove('hidden', 'warn');
      }
      break;
    case 'stream_event':
      onStreamEvent(msg.event || {});
      break;
    case 'assistant':
      if (msg.error || msg.message?.model === '<synthetic>') {
        const t = (msg.message?.content || []).map((b) => b.text || '').join(' ');
        liveTexts.forEach((n) => n.remove());
        liveTexts = [];
        notice(t || `Error: ${msg.error}`, true);
        if (msg.error === 'rate_limit') { $('statusPill').textContent = 'Usage limit reached'; $('statusPill').classList.add('warn'); }
      } else renderAssistant(msg.message || {});
      break;
    case 'user':
      renderUser(msg.message || {});
      break;
    case 'control_request':
      if (msg.request?.subtype === 'can_use_tool') permissionCard(msg.request_id, msg.request);
      break;
    case 'result': {
      setBusy(false);
      liveTexts.forEach((n) => n.classList.remove('caret'));
      liveTexts = [];
      if (msg.is_error && msg.subtype !== 'success') notice(msg.result || `Stopped: ${msg.subtype}`, true);
      const secs = msg.duration_ms ? `${(msg.duration_ms / 1000).toFixed(1)}s` : '';
      if (secs) append(el('div', 'turn-meta', esc(`${secs}${msg.num_turns > 1 ? ` · ${msg.num_turns} steps` : ''}`)));
      refreshConversations();
      break;
    }
    case 'stderr':
      stderrBuf = (stderrBuf + msg.text).slice(-4000);
      break;
    case 'exit':
      running = false;
      setBusy(false);
      if (msg.code) notice(`Claude Code stopped (code ${msg.code}).${stderrBuf.trim() ? '\n' + stderrBuf.trim().slice(-800) : ''}`, true);
      stderrBuf = '';
      break;
  }
});

// ---------- sending ----------

async function ensureStarted() {
  if (running) return true;
  stderrBuf = '';
  const r = await api.start(SID, { resume: claudeSessionId || undefined, model: settings.model, permissionMode: settings.permissionMode });
  if (!r.ok) { notice(r.error, true); return false; }
  running = true;
  return true;
}

async function sendMessage() {
  if (busy) { api.interrupt(SID); return; }
  const text = $('input').value.trim();
  if (!text && !attachments.length) return;
  const content = [
    ...attachments.map((a) => ({ type: 'image', source: { type: 'base64', media_type: a.type, data: a.data } })),
    ...(text ? [{ type: 'text', text }] : []),
  ];
  $('input').value = '';
  autosize();
  attachments = [];
  renderAttachments();
  if (!(await ensureStarted())) return;
  setBusy(true);
  if (!(await api.send(SID, content))) { setBusy(false); notice('Claude Code is not running. Try sending again.', true); running = false; }
}

function autosize() {
  const t = $('input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 260) + 'px';
}

function renderAttachments() {
  const box = $('attachments');
  box.innerHTML = '';
  attachments.forEach((a, i) => {
    const d = el('div', 'att', `<img src="data:${a.type};base64,${a.data}"><button title="Remove">×</button>`);
    d.querySelector('button').onclick = () => { attachments.splice(i, 1); renderAttachments(); };
    box.appendChild(d);
  });
}

$('input').addEventListener('input', autosize);
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) sendMessage(); }
});
$('input').addEventListener('paste', (e) => {
  for (const item of e.clipboardData?.items || []) {
    if (!item.type.startsWith('image/')) continue;
    e.preventDefault();
    const reader = new FileReader();
    reader.onload = () => {
      attachments.push({ type: item.type, data: String(reader.result).split(',')[1] });
      renderAttachments();
    };
    reader.readAsDataURL(item.getAsFile());
  }
});
$('sendBtn').onclick = sendMessage;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && busy && $('settingsModal').classList.contains('hidden')) api.interrupt(SID);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); newChat(); }
});

// copy buttons + external links
document.addEventListener('click', (e) => {
  const copy = e.target.closest('.copy');
  if (copy) {
    navigator.clipboard.writeText(copy.nextElementSibling.innerText);
    copy.textContent = 'Copied';
    setTimeout(() => (copy.textContent = 'Copy'), 1400);
    return;
  }
  const a = e.target.closest('a');
  if (a) {
    e.preventDefault();
    const href = a.dataset.href || a.getAttribute('href');
    if (/^https?:\/\//.test(href)) api.openExternal(href);
  }
});

// ---------- conversations ----------

async function refreshConversations() {
  const list = await api.listConversations(settings.cwd);
  const nav = $('convList');
  nav.innerHTML = '';
  for (const c of list) {
    const b = el('button', 'conv' + (c.id === claudeSessionId ? ' active' : ''), `<span>${esc(c.title)}</span>`);
    b.title = c.title;
    b.onclick = () => openConversation(c);
    nav.appendChild(b);
  }
  const cur = list.find((c) => c.id === claudeSessionId);
  $('chatTitle').textContent = cur ? cur.title : 'New chat';
}

function newChat() {
  api.stop(SID);
  running = false;
  setBusy(false);
  claudeSessionId = null;
  resetView();
  $('statusPill').classList.add('hidden');
  refreshConversations();
  api.announce(SID, { sessionId: null, origin: ORIGIN });
  closeMenu();
  $('input').focus();
}

async function openConversation(c) {
  api.stop(SID);
  running = false;
  setBusy(false);
  api.announce(SID, { sessionId: c.id, origin: ORIGIN });
  closeMenu();
  await showConversation(c.id);
}

async function showConversation(id) {
  claudeSessionId = id;
  resetView();
  $('empty')?.remove();
  stick = true;
  const history = await api.loadConversation(settings.cwd, id);
  for (const m of history) {
    if (m.type === 'user') renderUser(m.message);
    else renderAssistant(m.message);
  }
  toolRows.forEach((r) => { if (!r.classList.contains('failed')) r.classList.add('done'); });
  scroller.scrollTop = scroller.scrollHeight;
  refreshConversations();
}

$('newChat').onclick = newChat;
$('folderBtn').onclick = async () => {
  const dir = await api.pickFolder();
  if (!dir) return;
  settings.cwd = dir;
  await api.setSettings({ cwd: dir });
  $('folderName').textContent = baseName(dir);
  $('folderBtn').title = dir;
  newChat();
};

$('modelSel').onchange = async (e) => {
  settings.model = e.target.value;
  await api.setSettings({ model: settings.model });
  if (running) api.setModel(SID, settings.model);
};
$('modeSel').onchange = async (e) => {
  settings.permissionMode = e.target.value;
  await api.setSettings({ permissionMode: settings.permissionMode });
  if (running) api.setMode(SID, settings.permissionMode);
};

// ---------- settings ----------

let pendingAuth = 'token';
function paintAuth() {
  document.querySelectorAll('#authSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === pendingAuth));
  $('tokenBlock').classList.toggle('hidden', pendingAuth !== 'token');
  $('authHint').textContent = pendingAuth === 'token'
    ? 'Chats run on your long-lived OAuth token (from `claude setup-token`). Usage goes to the account that made it.'
    : 'Chats run on the account you signed into below with a full login.';
}
document.querySelectorAll('#authSeg button').forEach((b) => (b.onclick = () => { pendingAuth = b.dataset.v; paintAuth(); }));

async function refreshAuthStatus() {
  const s = await api.authStatus();
  if (s.error) { $('loginState').textContent = s.error; return s; }
  $('loginState').textContent = s.loggedIn ? `Signed in${s.email ? ' as ' + s.email : ''}${s.subscriptionType ? ' · ' + s.subscriptionType : ''}` : 'Not signed in';
  $('loginBtn').classList.toggle('hidden', !!s.loggedIn);
  $('logoutBtn').classList.toggle('hidden', !s.loggedIn);
  return s;
}

async function openSettings() {
  settings = await api.getSettings();
  pendingAuth = settings.authMode;
  paintAuth();
  $('tokenInput').value = '';
  $('tokenHint').innerHTML = settings.tokenSource === 'saved'
    ? 'A token is saved (encrypted on this computer). Type a new one to replace it, or <a href="#" id="forgetTok">forget it</a>.'
    : settings.tokenSource === 'environment' ? 'Using CLAUDE_CODE_OAUTH_TOKEN from your environment.' : 'No token found yet.';
  $('forgetTok')?.addEventListener('click', async (e) => {
    e.stopPropagation(); e.preventDefault();
    await api.setSettings({ token: '' });
    openSettings();
  });
  $('claudePath').value = settings.claudePath || '';
  $('claudeHint').textContent = settings.claudeFound ? `Found: ${settings.claudeFound}` : 'Claude Code was not found. Install it, or paste its full path here.';
  $('rcName').value = settings.rcName || '';
  $('settingsModal').classList.remove('hidden');
  refreshAuthStatus();
}

$('settingsBtn').onclick = openSettings;
$('settingsClose').onclick = () => $('settingsModal').classList.add('hidden');
$('settingsSave').onclick = async () => {
  const patch = { authMode: pendingAuth, claudePath: $('claudePath').value.trim(), rcName: $('rcName').value.trim() };
  if ($('tokenInput').value.trim()) patch.token = $('tokenInput').value.trim();
  const authChanged = patch.authMode !== settings.authMode || 'token' in patch;
  await api.setSettings(patch);
  settings = await api.getSettings();
  $('settingsModal').classList.add('hidden');
  if (authChanged && running) { api.stop(SID); running = false; setBusy(false); }
};

$('loginBtn').onclick = async () => {
  $('loginLog').textContent = '';
  $('loginLog').classList.remove('hidden');
  $('loginCodeRow').classList.remove('hidden');
  const r = await api.login();
  if (!r.ok) $('loginLog').textContent = r.error;
};
$('logoutBtn').onclick = async () => { await api.logout(); refreshAuthStatus(); };
$('loginCodeBtn').onclick = () => { api.loginInput($('loginCode').value.trim()); $('loginCode').value = ''; };
api.onLoginOutput((t) => {
  const log = $('loginLog');
  log.innerHTML += linkify(t);
  log.scrollTop = log.scrollHeight;
});
api.onLoginDone(() => { $('loginCodeRow').classList.add('hidden'); refreshAuthStatus(); });

// ---------- remote control ----------

// Claude's official Remote Control (needs a full login)
function paintRc(on) {
  $('rcState').textContent = on ? 'On: reachable from claude.ai and the Claude app' : 'Off';
  $('rcToggle').textContent = on ? 'Turn off' : 'Turn on';
  paintDot();
}
let rcOn = false, remoteOn = false;
function paintDot() { $('rcDot').classList.toggle('on', rcOn || remoteOn); }
$('rcToggle').onclick = async () => {
  if (await api.rcRunning()) { api.rcStop(); return; }
  const s = await api.authStatus();
  if (!s.loggedIn) {
    $('rcLog').textContent = 'This one needs a full login. Open Settings and press “Sign in” first. (Cirrus Remote above works on your token.)';
    return;
  }
  $('rcLog').textContent = '';
  const r = await api.rcStart();
  if (!r.ok) $('rcLog').textContent = r.error;
};
api.onRcOutput((t) => {
  const log = $('rcLog');
  log.innerHTML += linkify(t);
  log.scrollTop = log.scrollHeight;
});
api.onRcStatus(({ running: on, code }) => {
  rcOn = on;
  paintRc(on);
  if (!on && code) $('rcLog').innerHTML += linkify(`\n[stopped, code ${code}]`);
});

// Cirrus Remote: this app serves the chat to phones itself
let remoteClients = 0;
function paintRemote(info) {
  remoteOn = !!info?.running;
  paintDot();
  $('remoteToggle').textContent = remoteOn ? 'Turn off' : 'Turn on';
  $('remoteToggle').classList.toggle('primary', !remoteOn);
  $('remoteNewKey').classList.toggle('hidden', !remoteOn);
  $('remoteState').textContent = remoteOn ? `On · ${remoteClients || info.clients || 0} connected` : 'Off';
  const box = $('remoteLinks');
  box.innerHTML = '';
  if (!remoteOn || !info.links) { $('remoteFoot').textContent = ''; return; }
  if (!info.links.length) box.innerHTML = '<p class="hint">No network found. Connect to Wi-Fi or Tailscale.</p>';
  for (const l of info.links) {
    const card = el('div', 'qr-card', `<img alt="QR code" src="${l.qr}"><div><div class="qr-kind">${esc(l.kind)}</div>
      <a href="#" data-href="${esc(l.url)}" class="qr-url">${esc(l.url)}</a><button class="btn ghost qr-copy">Copy link</button></div>`);
    card.querySelector('.qr-copy').onclick = (e) => { navigator.clipboard.writeText(l.url); e.target.textContent = 'Copied'; setTimeout(() => (e.target.textContent = 'Copy link'), 1400); };
    box.appendChild(card);
  }
  $('remoteFoot').textContent = 'Anyone with this link can use Claude Code on this computer, so keep it private. “New link” cancels old ones. Off Wi-Fi, install Tailscale on your phone and use the Tailscale link.';
}
$('remoteToggle').onclick = async () => {
  if (remoteOn) { paintRemote(await api.remoteStop()); return; }
  const r = await api.remoteStart();
  if (!r.ok) { $('remoteFoot').textContent = r.error; return; }
  paintRemote(r);
};
$('remoteNewKey').onclick = async () => paintRemote(await api.remoteNewKey());
api.onRemoteClients(async (n) => { remoteClients = n; if (!REMOTE) paintRemote(await api.remoteInfo()); });

$('rcBtn').onclick = async () => {
  rcOn = await api.rcRunning();
  paintRc(rcOn);
  paintRemote(await api.remoteInfo());
  $('rcModal').classList.remove('hidden');
};
$('rcClose').onclick = () => $('rcModal').classList.add('hidden');

// phone layout: the chat list slides in from the left
const closeMenu = () => document.body.classList.remove('menu-open');
$('menuBtn').onclick = () => document.body.classList.toggle('menu-open');
$('scrim').onclick = closeMenu;

function setupRemoteClient() {
  document.body.classList.add('remote');
  for (const id of ['settingsBtn', 'rcBtn']) $(id).classList.add('hidden');
  $('folderBtn').disabled = true;
  const pill = $('statusPill');
  api.onRemoteLink((up) => {
    if (up) { pill.classList.add('hidden'); return; }
    pill.textContent = 'Reconnecting to your computer…';
    pill.classList.remove('hidden');
    pill.classList.add('warn');
  });
}

// close modals by clicking the backdrop
document.querySelectorAll('.modal').forEach((m) => m.addEventListener('mousedown', (e) => { if (e.target === m) m.classList.add('hidden'); }));

// ---------- boot ----------

(async () => {
  settings = await api.getSettings();
  $('modelSel').value = settings.model || '';
  $('modeSel').value = settings.permissionMode || 'manual';
  $('folderName').textContent = baseName(settings.cwd);
  $('folderBtn').title = settings.cwd;
  resetView();
  if (REMOTE) setupRemoteClient();
  const st = await api.sessionState(SID);
  const joinId = st.sessionId || st.active;
  if (joinId) { await showConversation(joinId); running = st.running; }
  else refreshConversations();
  paintRc(await api.rcRunning());
  paintRemote(await api.remoteInfo());
  if (!settings.claudeFound) notice('Claude Code was not found on this computer. Install it (https://claude.com/claude-code) or set its path in Settings.', true);
  else if (settings.authMode === 'token' && !settings.hasToken) notice('No OAuth token yet. Run `claude setup-token`, then paste the token in Settings (or set CLAUDE_CODE_OAUTH_TOKEN).');
  $('input').focus();
})();
