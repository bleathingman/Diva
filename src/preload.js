// Pont sécurisé : l'interface n'a accès qu'à ces fonctions, pas à Node.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('diva', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  getRecentApps: () => ipcRenderer.invoke('get-recent-apps'),
  launchApp: (name) => ipcRenderer.invoke('launch-app', name),
  runSetup: (name) => ipcRenderer.invoke('run-setup', name),
  getAppIcon: (name) => ipcRenderer.invoke('get-app-icon', name),
  media: (command) => ipcRenderer.send('media-command', command),
  hide: () => ipcRenderer.send('hide'),
  resize: (height) => ipcRenderer.send('resize', height),
  onConfig: (callback) => ipcRenderer.on('config', (_event, config) => callback(config)),
  onRecentApps: (callback) => ipcRenderer.on('recent-apps', (_event, apps) => callback(apps)),
  onMedia:(callback) => ipcRenderer.on('media', (_event, state) => callback(state)),
  onToast: (callback) => ipcRenderer.on('toast', (_event, message) => callback(message)),
});
