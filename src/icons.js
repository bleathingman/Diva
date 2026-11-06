// Icônes : celles des apps (raccourcis, .ico, logos du Store) et celles des sites épinglés.
const { app, nativeImage, net, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { expandEnv, isUri } = require('./paths');

// Pour un raccourci .lnk, Windows renverrait l'icône générique « fichier + flèche » :
// on prend l'icône déclarée par le raccourci, ou à défaut celle de sa cible.
function resolveIconSource(file) {
  if (!file.toLowerCase().endsWith('.lnk')) return file;
  try {
    const link = shell.readShortcutLink(file);
    // Les outils Windows déclarent souvent "%SystemRoot%\...\x.dll" : variable à remplacer,
    // et une .dll ne donne pas la bonne icône (il faudrait son index) : on prend alors la cible.
    const icon = link.icon && expandEnv(link.icon);
    if (icon && !/\.dll$/i.test(icon) && fs.existsSync(icon)) return icon;
    return link.target ? expandEnv(link.target) : file;
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

// Icône d'un site : d'abord celles déclarées dans la page (apple-touch-icon, la plus nette),
// puis /favicon.ico. Enregistrée en PNG dans `folder` ; renvoie son chemin, ou null.
async function fetchFavicon(pageUrl, folder) {
  const { origin } = new URL(pageUrl);
  const candidates = [];
  try {
    const html = await (await net.fetch(pageUrl)).text();
    for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
      const rel = /\brel=["']?([^"'>]+)/i.exec(tag)?.[1].toLowerCase() ?? '';
      const href = /\bhref=["']?([^"'\s>]+)/i.exec(tag)?.[1];
      if (!href || !rel.includes('icon') || /\.svg(\?|$)/i.test(href)) continue;
      candidates.push({ url: new URL(href, pageUrl).href, rank: rel.includes('apple-touch') ? 0 : 1 });
    }
  } catch {
    // Page inaccessible : on tente quand même /favicon.ico.
  }
  candidates.sort((a, b) => a.rank - b.rank);
  candidates.push({ url: `${origin}/favicon.ico` });

  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${crypto.createHash('md5').update(origin).digest('hex').slice(0, 12)}.png`);
  for (const { url } of candidates) {
    try {
      const response = await net.fetch(url);
      if (!response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      let image = nativeImage.createFromBuffer(buffer);
      if (image.isEmpty()) {
        // Les .ico ne se lisent que depuis un fichier.
        const ico = `${file}.ico`;
        fs.writeFileSync(ico, buffer);
        image = nativeImage.createFromPath(ico);
        fs.rmSync(ico, { force: true });
      }
      if (image.isEmpty()) continue;
      if (image.getSize().width > 64) image = image.resize({ width: 64, height: 64, quality: 'best' });
      fs.writeFileSync(file, image.toPNG());
      return file;
    } catch {
      // Candidat suivant.
    }
  }
  return null;
}

module.exports = { getAppIcon, fetchFavicon };
