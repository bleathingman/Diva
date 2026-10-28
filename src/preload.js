// Pont sécurisé : l'interface n'a accès qu'à ces fonctions, pas à Node.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('diva', {
  getGrid: () => ipcRenderer.invoke('get-grid'),
  getInstalledApps: () => ipcRenderer.invoke('get-installed-apps'),
  launchApp: (name) => ipcRenderer.invoke('launch-app', name),
  getAppIcon: (entry) => ipcRenderer.invoke('get-app-icon', { open: entry.open, iconFile: entry.iconFile }),
  updateGrid: (patch) => ipcRenderer.send('update-grid', patch),
  pinApp: (entry) => ipcRenderer.send('pin-app', { name: entry.name, open: entry.open, iconFile: entry.iconFile }),
  appMenu: (name) => ipcRenderer.send('app-menu', name),
  media: (command) => ipcRenderer.send('media-command', command),
  audio: (command) => ipcRenderer.send('audio-command', command),
  hide: () => ipcRenderer.send('hide'),
  resize: (height) => ipcRenderer.send('resize', height),
  onGrid: (callback) => ipcRenderer.on('grid', (_event, grid) => callback(grid)),
  onOpenSettings: (callback) => ipcRenderer.on('open-settings', () => callback()),
  onMedia: (callback) => ipcRenderer.on('media', (_event, state) => callback(state)),
  onAudio: (callback) => ipcRenderer.on('audio', (_event, state) => callback(state)),
  onToast: (callback) => ipcRenderer.on('toast', (_event, message) => callback(message)),
});
