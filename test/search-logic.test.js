const assert = require('node:assert');
const { test } = require('node:test');
const { calculate, searchable, initials, scoreEntry } = require('../src/renderer/search-logic');

test('calculatrice : opérations, priorités, pourcentages, virgules', () => {
  assert.strictEqual(calculate('12*4'), 48);
  assert.strictEqual(calculate('(2+3)*4'), 20);
  assert.strictEqual(calculate('2+3*4'), 14);
  assert.strictEqual(calculate('200*15%'), 30);
  assert.strictEqual(calculate('2^10'), 1024);
  assert.strictEqual(calculate('7,5+2,5'), 10);
  assert.strictEqual(calculate('6 x 7'), 42);
  assert.strictEqual(calculate('1/3'), 0.333333333333);
});

test('calculatrice : rien pour ce qui n\'est pas un calcul', () => {
  for (const text of ['12', '1/0', '3x', 'discord', '7zip', '(1+2', '']) {
    assert.strictEqual(calculate(text), null, text);
  }
});

test('recherche : accents ignorés et initiales', () => {
  assert.strictEqual(searchable('Pokémon Z'), 'pokemon z');
  assert.strictEqual(initials('visual studio code'), 'vsc');
});

test('recherche : classement des résultats', () => {
  const entry = (name, extra = {}) => ({ name, source: 'app', runs: 0, ...extra });
  const score = (name, query, extra) => scoreEntry(entry(name, extra), query);

  // Début du nom > début d'un mot > au milieu > initiales.
  assert.ok(score('Discord', 'disc') > score('Steam Discord', 'disc'));
  assert.ok(score('Steam Discord', 'disc') > score('Indiscord', 'disc'));
  assert.ok(score('Indiscord', 'disc') > score('Visual Studio Code', 'vsc'));
  assert.ok(score('Visual Studio Code', 'vsc') > 0);
  // Plus de « lettres dans le désordre » : c'était du bruit.
  assert.strictEqual(score('Windows Defender Firewall', 'disc'), 0);
  // À égalité, épinglées et apps souvent lancées passent devant.
  assert.ok(score('Discord', 'disc', { source: 'pinned' }) > score('Discord', 'disc'));
  assert.ok(score('Discord', 'disc', { source: 'recent', runs: 20 }) > score('Discord', 'disc', { source: 'recent', runs: 1 }));
});
