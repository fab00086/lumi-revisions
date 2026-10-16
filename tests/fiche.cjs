// Fiche de révision : l'IA transforme la conversation en fiche structurée
// (notions, méthode, exemples corrigés, quiz) pour impression/PDF. On vérifie
// le parse tolérant du JSON du modèle ET le rendu de la page imprimée
// (openFichePrint) — contenu riche et mise en page sont ce que l'utilisateur voit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const back = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const front = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function section(a, b) { const s = back.indexOf(a), e = back.indexOf(b, s); assert.ok(s >= 0 && e > s, 'section introuvable : ' + a); return back.slice(s, e); }
function frontSection(a, b) { const s = front.indexOf(a), e = front.indexOf(b, s); assert.ok(s >= 0 && e > s, 'section introuvable dans app.js : ' + a); return front.slice(s, e); }

function ctx(contenuModele) {
  return vm.createContext({
    console, JSON,
    callOllama: async () => ({ content: contenuModele, reasoning: '' })
  });
}

test('fiche : parse le JSON du modèle en fiche COMPLÈTE (notions + méthode + exemples corrigés + quiz)', async () => {
  const modele = [
    '```json',
    '{"titre":"Les fractions","resume":"On a comparé des fractions."',
    ',"notions":[{"titre":"Numérateur","contenu":"le nombre du haut"},{"titre":"Dénominateur","contenu":"le nombre du bas"}]',
    ',"methode":[{"titre":"Comparer","contenu":"mettre au même dénominateur"}]',
    ',"exemples":[{"enonce":"Comparer 2/3 et 3/4","correction":"2/3 = 8/12 et 3/4 = 9/12 donc 2/3 < 3/4"}]',
    ',"quiz":[{"question":"Quel est le dénominateur de 3/5 ?","reponse":"5"}]',
    ',"reussi":["comparer des fractions"],"a_reviser":["additionner des fractions"]',
    ',"astuce":"Le dénominateur est en bas."}',
    '```'
  ].join('\n');
  const c = ctx(modele);
  vm.runInContext(section('async function buildFiche(', "app.post('/api/fiche'"), c);
  const fiche = await c.buildFiche([{ role: 'user', content: 'une fraction, c\'est quoi ?' }, { role: 'assistant', content: 'Bonne question !' }], { age: 9 });
  assert.equal(fiche.titre, 'Les fractions');
  assert.equal(fiche.notions.length, 2);
  assert.equal(fiche.notions[0].titre, 'Numérateur');
  assert.equal(fiche.methode.length, 1);
  assert.equal(fiche.methode[0].titre, 'Comparer');
  assert.equal(fiche.exemples.length, 1);
  assert.equal(fiche.exemples[0].enonce, 'Comparer 2/3 et 3/4');
  assert.equal(fiche.exemples[0].correction.includes('donc'), true);
  assert.equal(fiche.quiz.length, 1);
  assert.equal(fiche.quiz[0].question, 'Quel est le dénominateur de 3/5 ?');
  assert.equal(fiche.quiz[0].reponse, '5');
  assert.deepEqual(fiche.reussi, ['comparer des fractions']);
  assert.equal(fiche.astuce.includes('dénominateur'), true);
});

test('fiche : exemples en texte simple (ancien format) — gardés en énoncé, jamais perdus', async () => {
  const modele = '{"titre":"Tables","notions":[{"titre":"7 x 8","contenu":"56"}],"exemples":["7 x 8 = 56"]}';
  const c = ctx(modele);
  vm.runInContext(section('async function buildFiche(', "app.post('/api/fiche'"), c);
  const fiche = await c.buildFiche([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], { age: 8 });
  assert.equal(fiche.exemples.length, 1);
  assert.equal(fiche.exemples[0].enonce, '7 x 8 = 56');
  assert.equal(fiche.exemples[0].correction, '');
  assert.equal(fiche.quiz.length, 0);
});

test('fiche : conversation vide ou trop courte -> aucune fiche (pas d\'appel inutile)', async () => {
  const c = ctx('{}');
  vm.runInContext(section('async function buildFiche(', "app.post('/api/fiche'"), c);
  assert.equal(await c.buildFiche([], { age: 9 }), null);
  assert.equal(await c.buildFiche([{ role: 'user', content: 'seul' }], { age: 9 }), null);
});

test('fiche : la liste a cocher pilote la generation (cours ajoute, quiz decoche retire)', async () => {
  let captured = null;
  const c = vm.createContext({
    console, JSON,
    callOllama: async (messages) => { captured = messages; return { content: '{"titre":"T","quiz":[{"question":"q ?","reponse":"r"}]}', reasoning: '' }; }
  });
  vm.runInContext(section('async function buildFiche(', "app.post('/api/fiche'"), c);
  const fiche = await c.buildFiche([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], { age: 9 }, { quiz: false, apprentissage: true });
  const sys = captured[0].content;
  assert.match(sys, /"cours"/, 'apprentissage coche : le schema demande le cours');
  assert.ok(!sys.includes('"quiz"'), 'quiz decoche : absent du schema');
  assert.match(sys, /"astuce"/, 'astuce cochee par defaut');
  assert.match(sys, /"notions"/, 'revision cochee par defaut');
  assert.equal(fiche.quiz.length, 0, 'le quiz decoche ne ressort pas dans la fiche');
});

test('fiche : la page imprimée rend notions, étapes numérotées, exemples corrigés, quiz et bilan', () => {
  let page = '';
  const fake = { document: { open() {}, write(h) { page += h; }, close() {} }, focus() {}, print() {} };
  const c = vm.createContext({ console, window: { open: () => fake }, toast() {}, setTimeout() {} });
  vm.runInContext(frontSection('function openFichePrint(', "$('btn-print')"), c);
  c.openFichePrint({
    titre: 'Les fractions', resume: 'On a comparé des fractions.',
    notions: [{ titre: 'Numérateur', contenu: 'le nombre du haut' }],
    methode: [{ titre: 'Comparer', contenu: 'même dénominateur' }],
    exemples: [{ enonce: 'Comparer 2/3 et 3/4', correction: '2/3 = 8/12 donc 2/3 < 3/4' }],
    quiz: [{ question: 'Dénominateur de 3/5 ?', reponse: '5' }],
    reussi: ['comparer'], a_reviser: ['additionner'], astuce: 'Le dénominateur est en bas.'
  }, 'Léa', 'CM1');
  assert.ok(page.includes('Les fractions'), 'titre affiché');
  assert.ok(page.includes('Léa · CM1'), 'nom + niveau affichés');
  assert.ok(page.includes('Numérateur'), 'notions affichées');
  assert.ok(page.includes('<span class="num">1</span>'), 'étapes numérotées');
  assert.ok(page.includes('même dénominateur'), 'méthode affichée');
  assert.ok(page.includes('Comparer 2/3 et 3/4') && page.includes('2/3 = 8/12 donc 2/3 &lt; 3/4'), 'exemples corrigés affichés');
  assert.ok(page.includes('Dénominateur de 3/5 ?'), 'question du quiz affichée');
  assert.ok(!page.includes('Réponse : 5'), 'la réponse ne colle pas à la question (on peut se tester à blanc)');
  assert.ok(page.includes('Corrigé du quiz') && page.includes('<strong>1.</strong> 5'), 'corrigé séparé en fin de fiche');
  assert.ok(page.includes('Bien compris') && page.includes('À retravailler'), 'bilan affiché');
  assert.ok(page.includes('Imprimer / Enregistrer en PDF'), 'bouton d\'impression présent');
});
