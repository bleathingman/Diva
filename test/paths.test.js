const assert = require('node:assert');
const { test } = require('node:test');
const { isUri, isPathLike, normalize, defaultLinkName, parseLinkTarget } = require('../src/paths');

test('isUri : les liens, pas les lecteurs', () => {
  assert.ok(isUri('spotify:'));
  assert.ok(isUri('https://github.com'));
  assert.ok(isUri('shell:AppsFolder\\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App'));
  assert.ok(!isUri('C:\\Program Files\\Steam\\steam.exe'));
  assert.ok(!isUri('C:/Jeux/jeu.exe'));
});

test('isPathLike : lecteur, partage réseau, variable', () => {
  assert.ok(isPathLike('C:\\Users'));
  assert.ok(isPathLike('\\\\serveur\\partage'));
  assert.ok(isPathLike('%USERPROFILE%\\Downloads'));
  assert.ok(!isPathLike('youtube.com'));
});

test('normalize : même app quel que soit le nom exact', () => {
  assert.strictEqual(normalize('Visual Studio Code'), normalize('visual-studio code'));
});

test('defaultLinkName : nom proposé pour une app, un dossier ou un site', () => {
  const cases = {
    '%USERPROFILE%\\OneDrive\\Bureau\\Pokémon Z V2.12 - Français\\Game.exe': 'Pokémon Z V2.12 - Français',
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe': 'firefox',
    'C:\\Users\\mathe\\Desktop\\Discord.lnk': 'Discord',
    'D:\\Jeux\\MonJeu\\Launcher.exe': 'MonJeu',
    'C:\\Users\\mathe\\Downloads': 'Downloads',
    'C:\\Users\\mathe\\Downloads\\': 'Downloads',
    'https://www.youtube.com/watch?v=1': 'youtube.com',
  };
  for (const [open, expected] of Object.entries(cases)) assert.strictEqual(defaultLinkName(open), expected, open);
});

test('parseLinkTarget : site, dossier, guillemets, erreurs', () => {
  const exists = (file) => file.startsWith('C:\\existe');
  assert.deepStrictEqual(parseLinkTarget('youtube.com', exists), { open: 'https://youtube.com' });
  assert.deepStrictEqual(parseLinkTarget('  "C:\\existe\\dossier"  ', exists), { open: 'C:\\existe\\dossier' });
  assert.deepStrictEqual(parseLinkTarget('spotify:', exists), { open: 'spotify:' });
  assert.deepStrictEqual(parseLinkTarget('', exists), { error: 'Indique une adresse ou un dossier' });
  assert.deepStrictEqual(parseLinkTarget('C:\\nexiste\\pas', exists), { error: 'Dossier ou fichier introuvable' });
  assert.deepStrictEqual(parseLinkTarget('pas une adresse', exists), { error: 'Adresse invalide' });
  // Bug corrigé : un retour à la ligne après « C: » faisait passer « C: » pour un protocole.
  assert.deepStrictEqual(parseLinkTarget('C:\nexistepas', exists), { error: 'Adresse invalide' });
});
