// Fiche de révision : l'IA transforme la conversation en fiche structurée
// (notions, méthode, exemples) pour impression/PDF. On vérifie le parse
// tolérant du JSON retourné par le modèle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const back = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function section(a, b) { const s = back.indexOf(a), e = back.indexOf(b, s); assert.ok(s >= 0 && e > s, 'section introuvable : ' + a); return back.slice(s, e); }

function ctx(contenuModele) {
  return vm.createContext({
    console, JSON,
    callOllama: async () => ({ content: contenuModele, reasoning: '' })
  });
}

test('fiche : parse le JSON du modèle en fiche COMPLETE (notions + méthode + exemples)', async () => {
  const modele = [
    '```json',
    '{"titre":"Les fractions","resume":"On a comparé des fractions."',
    ',"notions":[{"titre":"Numérateur","contenu":"le nombre du haut"},{"titre":"Dénominateur","contenu":"le nombre du bas"}]',
    ',"methode":[{"titre":"Comparer","contenu":"mettre au même dénominateur"}]',
    ',"exemples":["1/2 < 3/4"],"reussi":["comparer des fractions"],"a_reviser":["additionner des fractions"]',
    ',"astuce":"Le dénominateur est en bas."}',
    '```'
  ].join('\n');
  const c = ctx(modele);
  vm.runInContext(section('async function buildFiche(history, profile = {})', "app.post('/api/fiche'"), c);
  const fiche = await c.buildFiche([{ role: 'user', content: 'une fraction, c\'est quoi ?' }, { role: 'assistant', content: 'Bonne question !' }], { age: 9 });
  assert.equal(fiche.titre, 'Les fractions');
  assert.equal(fiche.notions.length, 2);
  assert.equal(fiche.notions[0].titre, 'Numérateur');
  assert.equal(fiche.methode.length, 1);
  assert.equal(fiche.methode[0].titre, 'Comparer');
  assert.deepEqual(fiche.exemples, ['1/2 < 3/4']);
  assert.deepEqual(fiche.reussi, ['comparer des fractions']);
  assert.equal(fiche.astuce.includes('dénominateur'), true);
});

test('fiche : conversation vide ou trop courte -> aucune fiche (pas d\'appel inutile)', async () => {
  const c = ctx('{}');
  vm.runInContext(section('async function buildFiche(history, profile = {})', "app.post('/api/fiche'"), c);
  assert.equal(await c.buildFiche([], { age: 9 }), null);
  assert.equal(await c.buildFiche([{ role: 'user', content: 'seul' }], { age: 9 }), null);
});
