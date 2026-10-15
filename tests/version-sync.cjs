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

const fromServer = server.match(/app\.get\('\/api\/version',\s*\(\w+,\s*res\) => res\.json\(\{ version: '([^']+)' \}\)\)/);
const fromUpdate = update.match(/const lumiInterfaceVersion = '([^']+)';/);
const fromSw = sw.match(/const CACHE = 'lumi-v(\d+)';/);

test('version : /api/version et update.js annoncent la MEME version d\'interface', () => {
  assert.ok(fromServer, 'server.js doit declarer /api/version avec une litterale');
  assert.ok(fromUpdate, 'update.js doit declarer lumiInterfaceVersion');
  assert.equal(fromUpdate[1], fromServer[1], 'update.js : lumiInterfaceVersion doit suivre la version serveur (sinon bouton + toast en boucle)');
});

test('service worker : le cache avance et n\'est jamais resté sur une version anterieure', () => {
  assert.ok(fromSw, 'sw.js doit declarer un cache lumi-vN');
  assert.ok(Number(fromSw[1]) >= 46, 'cache sw >= v46');
});