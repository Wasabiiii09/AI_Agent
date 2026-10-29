'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('companion', {
  init: () => ipcRenderer.invoke('init'),
  loadVrm: () => ipcRenderer.invoke('load-vrm'),
  sendText: (t) => ipcRenderer.send('user-text', t),
  confirm: (yes) => ipcRenderer.send('confirm', yes),
  setInteractive: (v) => ipcRenderer.send('set-interactive', v),
  ptt: (on) => ipcRenderer.send('ptt', on),
  avatarReady: (info) => ipcRenderer.send('avatar-ready', info),
  log: (m) => ipcRenderer.send('renderer-log', String(m)),
  on: (ch, fn) => {
    const ok = ['status', 'bubble', 'speak-chunk', 'stop-speech', 'confirm', 'interactive', 'interactive-hint', 'user-said'];
    if (ok.includes(ch)) ipcRenderer.on(ch, (_e, d) => fn(d));
  },
});
