'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('keyshell', Object.freeze({
  call: async (method, input) => { const r = await ipcRenderer.invoke('keyshell:call', method, input); if (!r.ok) throw new Error(r.error); return r.value; },
  subscribe: listener => { const handler = (_event, value) => listener(value); ipcRenderer.on('keyshell:event', handler); return () => ipcRenderer.removeListener('keyshell:event', handler); }
}));
