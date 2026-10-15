// Programmes officiels CP -> 3e : base SQL construite depuis data/programmes.json,
// recherche par mots-cles, injection tuteur/classe et source affichee.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const programmesJson = path.join(__dirname, '../data/programmes.json');
function section(a, b) { const start = source.indexOf(a), end = source.indexOf(b, start); assert.ok(start >= 0 && end > start, 'section introuvable : ' + a); return source.slice(start, end); }
// Contexte programme : __dirname pointe vers un dossier temporaire contenant
// une COPIE de data/programmes.json (jamais la vraie base du depot).
function fixture(extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-prog-'));
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  fs.copyFileSync(programmesJson, path.join(tmp, 'data', 'programmes.json'));
  const realPath = path;
  const fakePath = { join: (...a) => realPath.join(...a), dirname: () => tmp }; // __dirname fixe
  const c = vm.createContext({ console, fs, os: require('node:os'), path: fakePath, __dirname: tmp, structuredClone, JSON, process: { env: {}, getBuiltinModule: () => require('node:sqlite') }, ...(extra.avecCurriculum ? { CURRICULUM: extra.avecCurriculum } : {}) });
  vm.runInContext(section('// ---------- Programmes officiels (base SQL data/programmes.db) ----------', '// ---------- Stockage des donnees des enfants ----------'), c, { importModuleDynamically: s => import(s) });
  return { c, tmp };
}

test('programmes : la base SQL se construit depuis le JSON et couvre CP -> 3e', async () => {
  const { c, tmp } = fixture();
  await c.initProgrammes();
  const niveaux = [...c.programmeNiveaux()];
  assert.deepEqual(niveaux, ['CP', 'CE1', 'CE2', 'CM1', 'CM2', '6e', '5e', '4e', '3e']);
  const cm1 = c.programmeNiveau('CM1');
  assert.ok(cm1.length > 40, 'CM1 fournit ses notions (' + cm1.length + ')');
  const aire = cm1.find(r => /aire des rectangles/i.test(r.notion));
  assert.ok(aire && aire.matiereLabel === 'Mathématiques' && aire.attendu.length > 10);
  const pc3e = c.programmeNiveau('3e').filter(r => r.matiereLabel === 'Physique-Chimie');
  assert.ok(pc3e.every(r => r.attendu), 'la filière Physique-Chimie de 3e porte des attendus officiels');
  // Reconstruction idempotente : la base existe deja, aucun doublon cree.
  const n1 = c.programmeNiveau('6e').length;
  await c.initProgrammes();
  assert.equal(c.programmeNiveau('6e').length, n1);
  // Le fichier .db bien construit existe a cote du JSON (sur o2switch : cree au boot).
  assert.ok(fs.existsSync(path.join(tmp, 'data', 'programmes.db')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('programmes : recherche par mots-cles (sans accents) + repli vue generale', async () => {
  const { c, tmp } = fixture();
  await c.initProgrammes();
  const thales = c.programmeCherche('3e', 'thales triangle', 8);
  assert.ok(thales.length && thales.some(r => /Thalès/i.test(r.notion)));
  const rien = c.programmeCherche('CP', 'xylophone astronaute', 8);
  assert.deepEqual([...rien], []);
  // injection tuteur : compacte, par matiere
  const inj = c.programmeInjection('CM1');
  assert.ok(inj.includes('Français') && inj.includes('Mathématiques'));
  assert.ok(inj.length < 3000, 'injection restant dans un budget prompt (' + inj.length + ' caracteres)');
  // pour classe : match avec attendus, sinon vue generale
  const classe = c.programmePourClasse('3e', 'Thalès triangles');
  assert.match(classe, /Notions du programme officiel \(3e\)/);
  assert.match(classe, /attendu/i);
  const hors = c.programmePourClasse('CM1', 'qwerty xylophone zzz');
  assert.match(hors, /Programme officiel \(CM1\) a respecter/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('programmes : source affichee en permanence, cycle correct', async () => {
  const { c, tmp } = fixture();
  assert.match(c.programmeSource('CP').url, /programmes-de-cycle-2/);
  assert.match(c.programmeSource('CM2').title, /cycle 3/);
  assert.match(c.programmeSource('4e').url, /programmes-de-cycle-4/);
  assert.equal(c.programmeSource(''), null);
  assert.equal(c.programmeSource('terminale'), null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('programmes : sans JSON ni base, repli sur curriculum.json sans crash', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-prog-'));
  fs.mkdirSync(path.join(tmp, 'data'));
  const realPath = path;
  const c = vm.createContext({
    console, fs, os: require('node:os'), path: { join: (...a) => realPath.join(...a), dirname: () => tmp }, __dirname: tmp,
    process: { env: {}, getBuiltinModule: () => require('node:sqlite') },
    CURRICULUM: { CM1: { Maths: ['les nombres décimaux', "l'aire du rectangle"] } }
  });
  vm.runInContext(section('// ---------- Programmes officiels (base SQL data/programmes.db) ----------', '// ---------- Stockage des donnees des enfants ----------'), c, { importModuleDynamically: s => import(s) });
  await c.initProgrammes(); // pas de programmes.json : repli, pas d'exception
  assert.deepEqual([...c.programmeNiveaux()], ['CM1']);
  const rows = c.programmeNiveau('CM1');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].notion, 'les nombres décimaux');
  assert.equal(c.programmeInjection('CM1').includes('aire du rectangle'), true);
  fs.rmSync(tmp, { recursive: true, force: true });
});