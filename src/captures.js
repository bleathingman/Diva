// Captures d'écran récentes : dossiers de Windows surveillés, miniatures, glisser-déposer.
const { app, nativeImage } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const SHOWN = 3;
const THUMB_SIZE = { width: 320, height: 200 };
// Dossier « Captures d'écran » de Windows (FOLDERID_Screenshots), quand il a été déplacé.
const SCREENSHOTS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';
const SCREENSHOTS_VALUE = '{B7BEDE81-DF94-4682-A7D8-57A52620B86F}';

const expandEnv = (value) => value.replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? match);

function registryScreenshotsFolder() {
  return new Promise((resolve) => {
    execFile('reg', ['query', SCREENSHOTS_KEY, '/v', SCREENSHOTS_VALUE], { windowsHide: true }, (error, stdout) => {
      const match = !error && /REG_(?:EXPAND_)?SZ\s+(.+)/.exec(stdout);
      resolve(match ? expandEnv(match[1].trim()) : null);
    });
  });
}

// Outil Capture d'écran (Win+Maj+S, Impr. écran) et Game Bar Xbox (Win+Alt+Impr. écran).
async function captureFolders() {
  const candidates = [
    await registryScreenshotsFolder(),
    path.join(app.getPath('pictures'), 'Screenshots'),
    path.join(app.getPath('videos'), 'Captures'),
  ];
  const unique = [...new Set(candidates.filter(Boolean).map((folder) => path.resolve(folder)))];
  return unique.filter((folder) => fs.existsSync(folder));
}

function createCaptures({ onChange }) {
  let folders = [];
  let recent = [];
  let scanTimer = null;
  const thumbnails = new Map(); // "chemin|date" -> data URL

  async function scan() {
    const files = [];
    for (const folder of folders) {
      let names = [];
      try {
        names = await fs.promises.readdir(folder);
      } catch {
        continue;
      }
      for (const name of names.filter((entry) => IMAGE.test(entry))) {
        const file = path.join(folder, name);
        try {
          files.push({ path: file, name, time: (await fs.promises.stat(file)).mtimeMs });
        } catch {
          // Supprimée entre la liste et la lecture.
        }
      }
    }
    files.sort((a, b) => b.time - a.time);
    const next = files.slice(0, SHOWN);
    const changed = next.map((file) => `${file.path}|${file.time}`).join('/') !== recent.map((file) => `${file.path}|${file.time}`).join('/');
    recent = next;
    if (changed) onChange(recent);
  }

  // Une capture s'écrit en plusieurs fois : on attend que les événements se calment.
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 500);
  }

  async function start() {
    folders = await captureFolders();
    for (const folder of folders) fs.watch(folder, scheduleScan);
    await scan();
  }

  // Seules les captures affichées sont accessibles : l'interface ne peut pas lire n'importe quel fichier.
  const find = (file) => recent.find((entry) => entry.path === file);

  async function thumbnail(file) {
    const entry = find(file);
    if (!entry) return null;
    const key = `${entry.path}|${entry.time}`;
    if (!thumbnails.has(key)) {
      try {
        thumbnails.set(key, (await nativeImage.createThumbnailFromPath(entry.path, THUMB_SIZE)).toDataURL());
      } catch {
        thumbnails.set(key, null);
      }
    }
    return thumbnails.get(key);
  }

  return { start, list: () => recent, find, thumbnail, folders: () => folders };
}

module.exports = { createCaptures };
