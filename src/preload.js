// Pont sécurisé : l'interface n'a accès qu'à ces fonctions, pas à Node.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('diva', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  getGrid: () => ipcRenderer.invoke('get-grid'),
  getInstalledApps: () => ipcRenderer.invoke('get-installed-apps'),
  launchApp: (name) => ipcRenderer.invoke('launch-app', name),
  runSetup: (name) => ipcRenderer.invoke('run-setup', name),
  getAppIcon: (entry) => ipcRenderer.invoke('get-app-icon', { open: entry.open, iconFile: entry.iconFile }),
  updateGrid: (patch) => ipcRenderer.send('update-grid', patch),
  pinApp: (entry) => ipcRenderer.send('pin-app', { name: entry.name, open: entry.open, iconFile: entry.iconFile }),
  appMenu: (name) => ipcRenderer.send('app-menu', name),
  media: (command) => ipcRenderer.send('media-command', command),
  hide: () => ipcRenderer.send('hide'),
  resize: (height) => ipcRenderer.send('resize', height),
  onConfig: (callback) => ipcRenderer.on('config', (_event, config) => callback(config)),
  onGrid: (callback) => ipcRenderer.on('grid', (_event, grid) => callback(grid)),
  onOpenSettings: (callback) => ipcRenderer.on('open-settings', () => callback()),
  onMedia: (callback) => ipcRenderer.on('media', (_event, state) => callback(state)),
  onToast: (callback) => ipcRenderer.on('toast', (_event, message) => callback(message)),
});
