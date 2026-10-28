const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, shell, screen, nativeImage } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const WIDTH = 320;
const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'default-config.json');
const MEDIA_HELPER_PATH = path.join(__dirname, '..', 'helpers', 'media.ps1');
const AUDIO_HELPER_PATH = path.join(__dirname, '..', 'helpers', 'audio.ps1');
const RECENT_APPS_PATH = path.join(__dirname, '..', 'helpers', 'recent-apps.ps1');
const INSTALLED_APPS_PATH = path.join(__dirname, '..', 'helpers', 'installed-apps.ps1');
const RECENT_REFRESH_MS = 10 * 60 * 1000;

let win = null;
let tray = null;
let config = null;
let mediaHelper = null;
let audioHelper = null;
let recentApps = [];
let recentRefreshedAt = 0;
let installedApps = null; // promesse gardée en cache, la liste change rarement
let installedList = [];
let lastSavedConfig = '';
let quitting = false;

// --- Fichiers utilisateur (%APPDATA%\Diva) -------------------------------------------

const userFile = (name) => path.join(app.getPath('userData'), name);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadConfig() {
  const file = userFile('config.json');
  if (!fs.existsSync(file)) fs.copyFileSync(DEFAULT_CONFIG_PATH, file);
  const loaded = readJson(file, null);
  if (!loaded) {
    win?.webContents.send('toast', 'config.json invalide, ancienne config gardée');
    return config ?? readJson(DEFAULT_CONFIG_PATH, {});
  }
  return loaded;
}

function watchConfig() {
  let timer = null;
  fs.watch(userFile('config.json'), () => {
    // Windows déclenche souvent plusieurs événements pour une seule sauvegarde.
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Nos propres sauvegardes (panneau Réglages) sont déjà appliquées.
      let content = null;
      try {
        content = fs.readFileSync(userFile('config.json'), 'utf8');
      } catch {
        // Fichier en cours d'écriture : le prochain événement le relira.
      }
      if (content !== null && content !== lastSavedConfig) applyConfig();
    }, 200);
  });
}

function applyConfig() {
  const previousHotkey = config?.hotkey;
  const previousDays = gridSettings().recentDays;
  config = loadConfig();
  win?.setAlwaysOnTop(config.alwaysOnTop !== false);
  if (config.hotkey !== previousHotkey) registerHotkey(previousHotkey);
  sendGrid();
  if (gridSettings().recentDays !== previousDays) refreshRecentApps();
}

function saveConfig() {
  lastSavedConfig = JSON.stringify(config, null, 2);
  fs.writeFileSync(userFile('config.json'), lastSavedConfig);
  sendGrid();
}

// --- Lancement d'apps ----------------------------------------------------------------

const expandEnv = (value) => value.replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? match);

// "spotify:" ou "https://..." sont des liens ; "C:\..." est un chemin (lettre de lecteur).
const isUri = (value) => /^[a-z][a-z0-9+.-]+:/i.test(value) && !/^[a-z]:[\\/]/i.test(value);

async function openTarget(target) {
  const expanded = expandEnv(target);
  // Apps du Store et identifiants Windows : seul l'Explorateur sait ouvrir "shell:AppsFolder\...".
  if (expanded.toLowerCase().startsWith('shell:')) {
    spawn('explorer.exe', [expanded], { detached: true, stdio: 'ignore' }).unref();
    return null;
  }
  if (isUri(expanded)) {
    await shell.openExternal(expanded);
    return null;
  }
  const error = await shell.openPath(expanded);
  return error || null;
}

// Même règle que recent-apps.ps1 : "Visual Studio Code" et "visual-studio code" sont la même app.
const normalize = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

// Les apps de la config passent en premier : elles gardent leur emoji et leur chemin.
function findApp(name) {
  const id = normalize(name);
  return [...config.apps, ...gridSettings().pinned, ...recentApps].find((entry) => normalize(entry.name) === id);
}

async function launchApp(name) {
  const entry = findApp(name);
  if (!entry) return `App inconnue : ${name}`;
  const error = await openTarget(entry.open);
  return error ? `${entry.name} : ${error}` : null;
}

// Pour un raccourci .lnk, Windows renverrait l'icône générique « fichier + flèche » :
// on prend l'icône déclarée par le raccourci, ou à défaut celle de sa cible.
function resolveIconSource(file) {
  if (!file.toLowerCase().endsWith('.lnk')) return file;
  try {
    const link = shell.readShortcutLink(file);
    return link.icon || link.target || file;
  } catch {
    return file;
  }
}

// Reçoit l'app telle que l'interface l'affiche ({ open, iconFile }) : ça marche aussi
// pour les apps installées pas encore épinglées.
async function getAppIcon({ open, iconFile } = {}) {
  if (typeof iconFile === 'string' && iconFile) {
    const image = nativeImage.createFromPath(iconFile);
    return image.isEmpty() ? null : image.toDataURL();
  }
  if (typeof open !== 'string' || isUri(expandEnv(open))) return null;
  try {
    const source = resolveIconSource(expandEnv(open));
    // Un .ico se charge tel quel ; getFileIcon donnerait l'icône du type de fichier.
    const icon = source.toLowerCase().endsWith('.ico')
      ? nativeImage.createFromPath(source).resize({ width: 64, height: 64 })
      : await app.getFileIcon(source, { size: 'large' });
    return icon.isEmpty() ? null : icon.toDataURL();
  } catch {
    return null;
  }
}

// --- Grille d'apps : épinglées puis récentes --------------------------------------

const GRID_KEYS = ['count', 'fillWithRecent', 'recentDays', 'pinned', 'hidden'];

function gridSettings() {
  return { count: 8, fillWithRecent: true, recentDays: 30, pinned: [], hidden: [], ...config?.grid };
}

function updateGrid(patch) {
  const allowed = Object.fromEntries(Object.entries(patch).filter(([key]) => GRID_KEYS.includes(key)));
  config = { ...config, grid: { ...gridSettings(), ...allowed } };
  saveConfig();
}

function buildGrid() {
  const settings = gridSettings();
  const pinnedIds = new Set(settings.pinned.map((entry) => normalize(entry.name)));
  const hiddenIds = new Set(settings.hidden.map(normalize));
  const recent = settings.fillWithRecent
    ? recentApps.filter((entry) => !pinnedIds.has(normalize(entry.name)) && !hiddenIds.has(normalize(entry.name)))
    : [];
  const freeSlots = Math.max(0, settings.count - settings.pinned.length);
  return {
    title: settings.pinned.length ? 'Mes apps' : 'Récents',
    apps: [...settings.pinned.map((entry) => ({ ...withCurrentIcon(entry), pinned: true })), ...recent.slice(0, freeSlots)],
    settings,
  };
}

// Le logo d'une app du Store est dans un dossier qui porte sa version : après une mise à
// jour, l'ancien chemin n'existe plus. On reprend alors celui trouvé par les scripts.
function withCurrentIcon(entry) {
  if (!entry.iconFile || fs.existsSync(entry.iconFile)) return entry;
  const fresh = [...recentApps, ...installedList].find(sameApp(entry.name));
  return { ...entry, iconFile: fresh?.iconFile };
}

function sendGrid() {
  win?.webContents.send('grid', buildGrid());
}

// Compare une app (objet ou simple nom) à un nom, avec la même règle que normalize().
const sameApp = (name) => (entry) => normalize(entry.name ?? entry) === normalize(name);

function pinApp({ name, open, iconFile }) {
  const { pinned } = gridSettings();
  if (!name || !open || pinned.some(sameApp(name))) return;
  updateGrid({ pinned: [...pinned, iconFile ? { name, open, iconFile } : { name, open }] });
}

function unpinApp(name) {
  updateGrid({ pinned: gridSettings().pinned.filter((entry) => !sameApp(name)(entry)) });
}

function hideApp(name) {
  const { hidden } = gridSettings();
  if (!hidden.some(sameApp(name))) updateGrid({ hidden: [...hidden, name] });
}

function showAppMenu(name) {
  const pinned = gridSettings().pinned.some(sameApp(name));
  // Pour épingler une récente, on garde son icône de package si elle en a une.
  const entry = recentApps.find(sameApp(name)) ?? findApp(name);
  Menu.buildFromTemplate([
    pinned
      ? { label: 'Désépingler', click: () => unpinApp(name) }
      : { label: 'Épingler', click: () => entry && pinApp(entry) },
    { label: 'Masquer de la grille', visible: !pinned, click: () => hideApp(name) },
    { type: 'separator' },
    { label: 'Réglages des apps…', click: () => win.webContents.send('open-settings') },
  ]).popup({ window: win });
}

function runAppScript(script, args = []) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(error);
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      });
  });
}

function refreshRecentApps() {
  recentRefreshedAt = Date.now();
  runAppScript(RECENT_APPS_PATH, ['-Days', String(gridSettings().recentDays)])
    .then((apps) => {
      recentApps = apps;
      sendGrid();
    })
    .catch((error) => console.error('[recent-apps]', error.message));
}

function getInstalledApps() {
  installedApps ??= runAppScript(INSTALLED_APPS_PATH).then((apps) => {
    installedList = apps;
    return apps;
  }).catch((error) => {
    console.error('[installed-apps]', error.message);
    installedApps = null;
    return [];
  });
  return installedApps;
}

// --- Modules permanents : média (helpers/media.ps1) et volume (helpers/audio.ps1) ----

// Lance un script PowerShell qui tourne en continu : chaque ligne JSON qu'il écrit part vers
// l'interface sur `channel`, et send() lui transmet une commande. Relancé s'il s'arrête.
function startHelper(script, channel) {
  const helper = {
    process: null,
    send: (command) => helper.process?.stdin.write(`${String(command).replace(/[\r\n]/g, ' ')}\n`),
  };
  const start = () => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true });
    helper.process = child;
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        win?.webContents.send(channel, JSON.parse(line));
      } catch {
        // Ligne parasite (avertissement PowerShell...) : on l'ignore.
      }
    });
    child.stderr.on('data', (data) => console.error(`[${channel}]`, data.toString()));
    child.on('exit', () => {
      helper.process = null;
      if (!quitting) setTimeout(start, 2000);
    });
  };
  start();
  return helper;
}

// --- Fenêtre, barre des tâches, raccourci --------------------------------------------

function defaultPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x + workArea.width - WIDTH - 24, y: workArea.y + 24 };
}

function createWindow() {
  const saved = readJson(userFile('state.json'), {});
  const visibleOnScreen = saved.x !== undefined &&
    screen.getAllDisplays().some(({ workArea: a }) =>
      saved.x >= a.x && saved.x < a.x + a.width && saved.y >= a.y && saved.y < a.y + a.height);
  const { x, y } = visibleOnScreen ? saved : defaultPosition();

  win = new BrowserWindow({
    x, y,
    width: WIDTH,
    height: 400,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: config.alwaysOnTop !== false,
    show: false,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.on('moved', () => {
    const [newX, newY] = win.getPosition();
    fs.writeFileSync(userFile('state.json'), JSON.stringify({ x: newX, y: newY }));
  });
}

function toggleWindow() {
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    win.focus();
    if (Date.now() - recentRefreshedAt > 60_000) refreshRecentApps();
  }
}

function registerHotkey(previous) {
  if (previous) globalShortcut.unregister(previous);
  if (!config.hotkey) return;
  if (!globalShortcut.register(config.hotkey, toggleWindow)) {
    win?.webContents.send('toast', `Raccourci ${config.hotkey} déjà pris par une autre app`);
  }
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 }));
  tray.setToolTip('Diva');
  tray.on('click', toggleWindow);
  const refreshMenu = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Afficher / masquer', click: toggleWindow },
    { label: 'Modifier la config', click: () => shell.openPath(userFile('config.json')) },
    {
      label: 'Lancer au démarrage de Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
        refreshMenu();
      },
    },
    { type: 'separator' },
    { label: 'Quitter', click: () => app.quit() },
  ]));
  refreshMenu();
}

// --- Communication avec l'interface --------------------------------------------------

ipcMain.handle('get-grid', () => buildGrid());
ipcMain.handle('get-installed-apps', () => getInstalledApps());
ipcMain.handle('launch-app', (_event, name) => launchApp(name));
ipcMain.handle('get-app-icon', (_event, entry) => getAppIcon(entry));
ipcMain.on('update-grid', (_event, patch) => updateGrid(patch));
ipcMain.on('pin-app', (_event, entry) => pinApp(entry));
ipcMain.on('app-menu', (_event, name) => showAppMenu(name));
ipcMain.on('media-command', (_event, command) => mediaHelper?.send(command));
ipcMain.on('audio-command', (_event, command) => audioHelper?.send(command));
ipcMain.on('hide', () => win.hide());
ipcMain.on('resize', (_event, height) => win.setContentSize(WIDTH, Math.ceil(height)));

// --- Démarrage -----------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    config = loadConfig();
    createWindow();
    createTray();
    registerHotkey();
    watchConfig();
    mediaHelper = startHelper(MEDIA_HELPER_PATH, 'media');
    audioHelper = startHelper(AUDIO_HELPER_PATH, 'audio');
    refreshRecentApps();
    setInterval(() => {
      installedApps = null;
      refreshRecentApps();
    }, RECENT_REFRESH_MS);
  });

  app.on('before-quit', () => {
    quitting = true;
    mediaHelper?.process?.stdin.end();
    audioHelper?.process?.stdin.end();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  // Le widget vit dans la barre des tâches : on ne quitte pas quand la fenêtre est cachée.
  app.on('window-all-closed', () => {});
}
