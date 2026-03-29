const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nova', {
  transcribe: (audioBuffer) => ipcRenderer.invoke('nova:transcribe', audioBuffer),
  chat: (message) => ipcRenderer.invoke('nova:chat', message),
  execute: (command) => ipcRenderer.invoke('nova:execute', command),
  speak: (text) => ipcRenderer.invoke('nova:speak', text),
  stopSpeaking: () => ipcRenderer.invoke('nova:stop-speaking'),
  checkConfig: () => ipcRenderer.invoke('nova:check-config'),
  bootDiagnostics: () => ipcRenderer.invoke('nova:boot-diagnostics'),

  onToggleListen: (callback) => ipcRenderer.on('nova:toggle-listen', callback),
  onSpeakingStarted: (callback) => ipcRenderer.on('nova:speaking-started', callback),
  onSpeakingEnded: (callback) => ipcRenderer.on('nova:speaking-ended', callback),
});
