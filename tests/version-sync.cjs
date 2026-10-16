// Bug du 15/10 : update.js gardait l'ancienne version d'interface (14.2) alors
// que /api/version annoncait 15.1 -> bouton « Mettre a jour » et toast affichés
// en boucle sur tous les appareils. Cette liaison en interdit le retour.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const update = fs.readFileSync(path.join(__dirname, '../public/update.js'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

const fromServer = server.match(/app\.get\('\/api\/version',\s*\(\w+,\s*res\) => res\.json\(\{ version: '([^']+)' \}\)\)/);
const fromUpdate = update.match(/const lumiInterfaceVersion = '([^']+)';/);
const fromSw = sw.match(/const CACHE = 'lumi-v(\d+)';/);
const appVer = html.match(/src="app\.js\?v=(\d+)"/);
const cssVer = html.match(/href="style\.css\?v=(\d+)"/);

test('version : /api/version et update.js annoncent la MEME version d\'interface', () => {
  assert.ok(fromServer, 'server.js doit declarer /api/version avec une litterale');
  assert.ok(fromUpdate, 'update.js doit declarer lumiInterfaceVersion');
  assert.equal(fromUpdate[1], fromServer[1], 'update.js : lumiInterfaceVersion doit suivre la version serveur (sinon bouton + toast en boucle)');
});

test('service worker : le cache avance et n\'est jamais resté sur une version anterieure', () => {
  assert.ok(fromSw, 'sw.js doit declarer un cache lumi-vN');
  assert.ok(Number(fromSw[1]) >= 55, 'cache sw >= v55');
});

test('cache-buster iOS : app.js et style.css portent le meme numero que le SW (sinon l\'iPhone garde l\'ancienne version)', () => {
  assert.ok(fromSw && appVer && cssVer, 'index.html doit charger app.js?v=N et style.css?v=N');
  assert.equal(appVer[1], fromSw[1], 'app.js?v doit suivre le numero de cache du SW');
  assert.equal(cssVer[1], fromSw[1], 'style.css?v doit suivre le numero de cache du SW');
});

test('apercu design : la page /design existe avec la fiche exemple et le bouton d\'impression', () => {
  const design = fs.readFileSync(path.join(__dirname, '../public/design.html'), 'utf8');
  assert.match(server, /app\.get\('\/design'/, 'la route /design doit exister');
  assert.match(design, /Aperçu design/);
  assert.match(design, /id="fiche-sheet"/, 'la fiche exemple doit etre presente');
  assert.match(design, /window\.print\(\)/, 'le bouton d\'impression doit etre present');
  assert.match(design, /fiche-opt|Créer ma fiche/, 'la liste a cocher doit etre montree');
});

test('ecran de chargement : barre de progression + animation, et fermeture branchee', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.match(html, /id="splash"/, 'index.html doit contenir l ecran de chargement');
  assert.match(html, /splash-fill/, 'la barre de progression doit etre presente');
  assert.match(html, /splash-pencil/, 'l animation du crayon doit etre presente');
  assert.match(html, /setTimeout\(\(\) => \{[\s\S]*10000|8000/, 'la securite anti-blocage doit exister');
  assert.match(app, /function hideSplash\(\)/, 'hideSplash doit exister');
  assert.ok((app.match(/hideSplash\(\)/g) || []).length >= 4, 'hideSplash doit etre appele sur chaque sortie d initialisation');
});