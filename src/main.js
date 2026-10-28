const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, shell, screen, nativeImage } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const WIDTH = 320;
const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'default-config.json');
const MEDIA_HELPER_PATH = path.join(__dirname, '..', 'helpers', 'media.ps1');

let win = null;
let tray = null;
let config = null;
let mediaHelper = null;
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
    timer = setTimeout(applyConfig, 200);
  });
}

function applyConfig() {
  const previousHotkey = config?.hotkey;
  config = loadConfig();
  win?.setAlwaysOnTop(config.alwaysOnTop !== false);
  if (config.hotkey !== previousHotkey) registerHotkey(previousHotkey);
  win?.webContents.send('config', config);
}

// --- Lancement d'apps ----------------------------------------------------------------

const expandEnv = (value) => value.replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? match);

// "spotify:" ou "https://..." sont des liens ; "C:\..." est un chemin (lettre de lecteur).
const isUri = (value) => /^[a-z][a-z0-9+.-]+:/i.test(value) && !/^[a-z]:[\\/]/i.test(value);

async function openTarget(target) {
  const expanded = expandEnv(target);
  if (isUri(expanded)) {
    await shell.openExternal(expanded);
    return null;
  }
  const error = await shell.openPath(expanded);
  return error || null;
}

function findApp(name) {
  return config.apps.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
}

async function launchApp(name) {
  const entry = findApp(name);
  if (!entry) return `App inconnue : ${name}`;
  const error = await openTarget(entry.open);
  return error ? `${entry.name} : ${error}` : null;
}

async function runSetup(name) {
  const setup = config.setups.find((entry) => entry.name === name);
  if (!setup) return [`Setup inconnu : ${name}`];
  const errors = [];
  for (const appName of setup.apps) {
    const error = await launchApp(appName);
    if (error) errors.push(error);
    // Un petit délai évite que toutes les fenêtres se battent pour le focus.
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return errors;
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

async function getAppIcon(name) {
  const entry = findApp(name);
  if (!entry || isUri(expandEnv(entry.open))) return null;
  try {
    const source = resolveIconSource(expandEnv(entry.open));
    // Un .ico se charge tel quel ; getFileIcon donnerait l'icône du type de fichier.
    const icon = source.toLowerCase().endsWith('.ico')
      ? nativeImage.createFromPath(source).resize({ width: 64, height: 64 })
      : await app.getFileIcon(source, { size: 'large' });
    return icon.isEmpty() ? null : icon.toDataURL();
  } catch {
    return null;
  }
}

// --- Contrôle média (helpers/media.ps1) ----------------------------------------------

function startMediaHelper() {
  mediaHelper = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', MEDIA_HELPER_PATH,
  ], { windowsHide: true });

  readline.createInterface({ input: mediaHelper.stdout }).on('line', (line) => {
    try {
      win?.webContents.send('media', JSON.parse(line));
    } catch {
      // Ligne parasite (avertissement PowerShell...) : on l'ignore.
    }
  });
  mediaHelper.stderr.on('data', (data) => console.error('[media]', data.toString()));

  mediaHelper.on('exit', () => {
    mediaHelper = null;
    if (!quitting) setTimeout(startMediaHelper, 2000);
  });
}

function sendMediaCommand(command) {
  mediaHelper?.stdin.write(`${command}\n`);
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

ipcMain.handle('get-config', () => config);
ipcMain.handle('launch-app', (_event, name) => launchApp(name));
ipcMain.handle('run-setup', (_event, name) => runSetup(name));
ipcMain.handle('get-app-icon', (_event, name) => getAppIcon(name));
ipcMain.on('media-command', (_event, command) => sendMediaCommand(command));
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
    startMediaHelper();
  });

  app.on('before-quit', () => {
    quitting = true;
    mediaHelper?.stdin.end();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  // Le widget vit dans la barre des tâches : on ne quitte pas quand la fenêtre est cachée.
  app.on('window-all-closed', () => {});
}
