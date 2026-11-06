// Chemins, liens et noms : du calcul pur, sans Electron (testé dans test/paths.test.js).
const path = require('path');

const expandEnv = (value) => value.replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? match);

// "spotify:" ou "https://..." sont des liens ; "C:\..." est un chemin (lettre de lecteur).
const isUri = (value) => /^[a-z][a-z0-9+.-]+:/i.test(value) && !/^[a-z]:[\\/]/i.test(value);

// Chemin Windows : lecteur, partage réseau (\\serveur) ou variable (%USERPROFILE%...).
const isPathLike = (value) => /^([a-z]:[\\/]|\\\\|%)/i.test(value);

// Même règle que recent-apps.ps1 : "Visual Studio Code" et "visual-studio code" sont la même app.
const normalize = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

// Noms d'exécutables qui ne disent rien du programme (même liste que recent-apps.ps1).
const GENERIC_EXE_NAMES = ['game', 'launcher', 'start', 'play', 'main', 'nw', 'nwjs', 'electron', 'unity'];

// Nom proposé pour un lien : nom du fichier (sans extension) ou du dossier, ou nom du site.
function defaultLinkName(open) {
  if (isPathLike(open)) {
    const file = expandEnv(open).replace(/[\\/]+$/, '');
    // Pour une app on retire l'extension ; "Game.exe" -> nom du dossier qui le contient.
    const name = /\.(exe|lnk|url|bat|cmd)$/i.test(file) ? path.win32.parse(file).name : path.win32.basename(file);
    if (GENERIC_EXE_NAMES.includes(name.toLowerCase())) return path.win32.basename(path.win32.dirname(file));
    return name || open;
  }
  try {
    return new URL(open).hostname.replace(/^www\./, '') || open;
  } catch {
    return open;
  }
}

// Ce que l'utilisateur a tapé dans « + Lien » -> { open } prêt à épingler, ou { error }.
// exists(chemin) vérifie qu'un chemin existe (fs.existsSync en vrai, un faux dans les tests).
function parseLinkTarget(target, exists) {
  // Sans caractères de contrôle ni guillemets (ceux du « Copier en tant que chemin » de Windows).
  let open = String(target ?? '').replace(/[\u0000-\u001f]/g, '').trim().replace(/^"(.*)"$/, '$1');
  if (!open) return { error: 'Indique une adresse ou un dossier' };
  if (isPathLike(open)) {
    return exists(expandEnv(open)) ? { open } : { error: 'Dossier ou fichier introuvable' };
  }
  // "youtube.com" tout court : on suppose un site web. Un protocole fait au moins 2 lettres
  // ("C:" est un lecteur, pas un protocole).
  if (!/^[a-z][a-z0-9+.-]+:/i.test(open)) open = `https://${open}`;
  try {
    new URL(open);
  } catch {
    return { error: 'Adresse invalide' };
  }
  return { open };
}

module.exports = { expandEnv, isUri, isPathLike, normalize, GENERIC_EXE_NAMES, defaultLinkName, parseLinkTarget };
