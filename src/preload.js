// Exposes a small, explicit API to the UI; the page never gets Node access.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const h = (_e, v) => fn(v);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('cirrus', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  listConversations: (cwd) => ipcRenderer.invoke('conv:list', cwd),
  loadConversation: (cwd, id) => ipcRenderer.invoke('conv:load', cwd, id),

  start: (sid, opts) => ipcRenderer.invoke('cc:start', sid, opts),
  send: (sid, content) => ipcRenderer.invoke('cc:send', sid, content),
  interrupt: (sid) => ipcRenderer.invoke('cc:interrupt', sid),
  answerPermission: (sid, id, resp) => ipcRenderer.invoke('cc:permission', sid, id, resp),
  setMode: (sid, mode) => ipcRenderer.invoke('cc:setMode', sid, mode),
  setModel: (sid, model) => ipcRenderer.invoke('cc:setModel', sid, model),
  stop: (sid) => ipcRenderer.invoke('cc:stop', sid),
  onEvent: on('cc:event'),

  rcStart: () => ipcRenderer.invoke('rc:start'),
  rcStop: () => ipcRenderer.invoke('rc:stop'),
  rcRunning: () => ipcRenderer.invoke('rc:running'),
  onRcOutput: on('rc:output'),
  onRcStatus: on('rc:status'),

  authStatus: () => ipcRenderer.invoke('auth:status'),
  login: () => ipcRenderer.invoke('auth:login'),
  loginInput: (t) => ipcRenderer.invoke('auth:loginInput', t),
  logout: () => ipcRenderer.invoke('auth:logout'),
  onLoginOutput: on('login:output'),
  onLoginDone: on('login:done'),

  openExternal: (url) => ipcRenderer.invoke('open:external', url),
});
