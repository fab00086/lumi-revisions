// Bouton Aide : questions courantes pre-ecrites (instantanees, sans IA) +
// questions libres repondues par Savika via /api/aide (elle connait les
// fonctions et parametres de l'app, sans jamais reveler l'interne).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const back = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const front = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

test('aide : bouton sur les profils + dans les reglages, fenetre complete', () => {
  assert.match(html, /id="help-modal"/);
  assert.match(html, /id="btn-help"/);
  assert.match(html, /id="btn-help-settings"/);
  assert.match(html, /id="help-input"/);
  assert.match(html, /id="btn-help-ask"/);
});

test('aide : au moins 8 questions courantes pre-ecrites (sans appel IA)', () => {
  const start = front.indexOf('const HELP_QA = [');
  const end = front.indexOf('];', start);
  assert.ok(start >= 0 && end > start, 'HELP_QA introuvable');
  const bloc = front.slice(start, end);
  const questions = (bloc.match(/\{ q: '/g) || []).length;
  assert.ok(questions >= 8, 'questions courantes : ' + questions);
  assert.match(bloc, /Installer Savika/);
  assert.match(bloc, /Fiche de révision/);
  assert.match(bloc, /Voix de Savika/);
});

test('aide : Savika connait les fonctions de l app, et reste privee', () => {
  const start = back.indexOf('function aideSystemPrompt()');
  const end = back.indexOf("app.post('/api/aide'", start);
  assert.ok(start >= 0 && end > start, 'aideSystemPrompt introuvable');
  const c = vm.createContext({});
  vm.runInContext(back.slice(start, end), c);
  const t = c.aideSystemPrompt();
  assert.match(t, /Fiche/);
  assert.match(t, /Quiz/);
  assert.match(t, /Voix/);
  assert.match(t, /Installation/);
  assert.match(t, /Mise/);
  assert.match(t, /Confidentialite/);
  assert.match(t, /Jamais de details techniques internes/);
});
