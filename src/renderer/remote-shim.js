// In a phone browser there is no Electron bridge: provide the same `window.cirrus`
// API over HTTP (calls) and Server-Sent Events (live updates) to the desktop app.
(() => {
  if (window.cirrus) return;
  window.CIRRUS_REMOTE = true;
  const key = new URLSearchParams(location.search).get('k') || '';
  const listeners = {};
  const call = async (name, ...args) => {
    const r = await fetch(`/api/call?k=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args }),
    });
    if (r.status === 401) throw new Error('This link is no longer valid. Scan the new QR code in Cirrus.');
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.result;
  };
  const on = (channel) => (fn) => {
    (listeners[channel] ||= new Set()).add(fn);
    return () => listeners[channel].delete(fn);
  };
  const emit = (channel, payload) => listeners[channel]?.forEach((fn) => fn(payload));

  let es;
  const connect = () => {
    es = new EventSource(`/api/events?k=${encodeURIComponent(key)}`);
    es.onopen = () => emit('remote:link', true);
    es.onmessage = (e) => { const { channel, payload } = JSON.parse(e.data); emit(channel, payload); };
    es.onerror = () => { emit('remote:link', false); es.close(); setTimeout(connect, 2000); };
  };
  connect();

  const unavailable = async () => { throw new Error('Not available from a phone'); };
  window.cirrus = {
    getSettings: () => call('settings:get'),
    setSettings: (patch) => call('settings:setChat', patch),
    pickFolder: async () => null,
    listConversations: (cwd) => call('conv:list', cwd),
    loadConversation: (cwd, id) => call('conv:load', cwd, id),

    start: (sid, opts) => call('cc:start', sid, opts),
    send: (sid, content) => call('cc:send', sid, content),
    interrupt: (sid) => call('cc:interrupt', sid),
    answerPermission: (sid, id, resp) => call('cc:permission', sid, id, resp),
    setMode: (sid, mode) => call('cc:setMode', sid, mode),
    setModel: (sid, model) => call('cc:setModel', sid, model),
    stop: (sid) => call('cc:stop', sid),
    sessionState: (sid) => call('cc:state', sid),
    announce: (sid, info) => call('cc:announce', sid, info),
    onEvent: on('cc:event'),
    onRemoteLink: on('remote:link'),

    rcStart: unavailable, rcStop: unavailable, rcRunning: async () => false,
    onRcOutput: on('rc:output'), onRcStatus: on('rc:status'),
    remoteStart: unavailable, remoteStop: unavailable, remoteInfo: async () => ({ running: true }), remoteNewKey: unavailable,
    onRemoteClients: on('remote:clients'),
    authStatus: () => call('auth:status'),
    login: unavailable, loginInput: unavailable, logout: unavailable,
    onLoginOutput: on('login:output'), onLoginDone: on('login:done'),
    openExternal: async (url) => window.open(url, '_blank', 'noopener'),
  };
})();
