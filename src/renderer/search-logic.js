// Logique de la recherche, sans interface : comparaison des noms, calculatrice, classement.
// Chargé par index.html avant app.js (fonctions globales), et importé par les tests (module.exports).

// Même règle que le processus principal : sert à reconnaître une app quel que soit son nom exact.
const normalize = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
// Pour la recherche on ignore les accents : "pokemon" doit trouver "Pokémon Z".
const searchable = (text) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Calculatrice : + - * / ^ ( ) et "15%" (= 0,15). Pas d'eval : un petit analyseur.
function calculate(text) {
  const source = text.replace(/\s+/g, '').replace(/,/g, '.').replace(/[x×]/gi, '*').replace(/÷/g, '/');
  if (!/^[\d.+\-*/^%()]+$/.test(source) || !/\d/.test(source) || !/[+\-*/^%]/.test(source.slice(1))) return null;
  let index = 0;
  const peek = () => source[index] ?? '';
  const number = () => {
    const match = /^\d*\.?\d+/.exec(source.slice(index));
    if (!match) throw new Error('nombre attendu');
    index += match[0].length;
    let value = Number(match[0]);
    if (peek() === '%') {
      index++;
      value /= 100;
    }
    return value;
  };
  const primary = () => {
    if (peek() !== '(') return number();
    index++;
    const value = sum();
    if (source[index++] !== ')') throw new Error('parenthèse');
    return value;
  };
  const unary = () => {
    if (peek() === '-') { index++; return -unary(); }
    if (peek() === '+') { index++; return unary(); }
    return primary();
  };
  const power = () => {
    const base = unary();
    if (peek() !== '^') return base;
    index++;
    return base ** power();
  };
  const product = () => {
    let value = power();
    while (peek() === '*' || peek() === '/') {
      const operator = source[index++];
      value = operator === '*' ? value * power() : value / power();
    }
    return value;
  };
  function sum() {
    let value = product();
    while (peek() === '+' || peek() === '-') {
      const operator = source[index++];
      value = operator === '+' ? value + product() : value - product();
    }
    return value;
  }
  try {
    const value = sum();
    return index === source.length && Number.isFinite(value) ? Number(value.toPrecision(12)) : null;
  } catch {
    return null;
  }
}

// Initiales des mots : "Visual Studio Code" -> "vsc".
const initials = (text) => text.split(/[\s\-_.]+/).map((word) => word[0] ?? '').join('');

// Plus le nom colle à la recherche, plus le score est haut ; on favorise ensuite
// les épinglées et les apps souvent lancées.
function scoreEntry(entry, query) {
  const name = searchable(entry.name);
  let score;
  if (name.startsWith(query)) score = 100;
  else if (name.split(/[\s\-_.]+/).some((word) => word.startsWith(query))) score = 80;
  else if (name.includes(query)) score = 60;
  else if (query.length > 1 && initials(name).startsWith(query)) score = 55;
  else return 0;
  if (entry.source === 'pinned') score += 15;
  if (entry.source === 'recent') score += 8 + Math.min(entry.runs, 20) / 2;
  return score;
}

if (typeof module !== 'undefined') module.exports = { normalize, searchable, calculate, initials, scoreEntry };
