// Bug du 14/10 : derrière le proxy d'o2switch, req.ip = IP du proxy pour tout
// le monde -> le compteur de tentatives de code était GLOBAL : au 21e essai de
// n'importe quelle famille, « Trop de tentatives » même avec le bon code
// (l'app semblait ne jamais s'ouvrir avec le code et l'adresse).
// Correctif : app.set('trust proxy', 1) inconditionnel au démarrage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function section(a, b) { const start = source.indexOf(a), end = source.indexOf(b, start); assert.ok(start >= 0 && end > start, 'section introuvable : ' + a); return source.slice(start, end); }

test('gate : le compteur de tentatives est par IP client (proxy inclus), plus jamais global', async () => {
  // L'app reelle est injectee (les `const` script vm ne survivent pas d'un
  // runInContext a l'autre). La ligne de boot lue dans server.js s'applique
  // a cette app : app.set('trust proxy', 1).
  const realApp = express();
  const c = vm.createContext({ express, console, app: realApp });
  vm.runInContext(section("app.set('trust proxy', 1);", '// Stripe : le webhook'), c);
  vm.runInContext(section('// ---------- Limitation des tentatives ----------', 'function hasAccess(req)'), c);
  const app = realApp;
  app.get('/gate-test', (req, res) => { if (!c.allowLoginAttempt(req, res, 'test', 3)) return; res.json({ ok: true, ip: req.ip }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const essai = async ip => {
    const r = await fetch(base + '/gate-test', { headers: ip ? { 'X-Forwarded-For': ip } : {} });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    // Derriere le proxy, l'IP reelle du client arrive dans X-Forwarded-For.
    const a = await essai('10.0.0.1');
    assert.equal(a.body.ip, '10.0.0.1', 'req.ip = l IP du client derriere le proxy');
    assert.equal(a.status, 200); assert.equal((await essai('10.0.0.1')).status, 200); assert.equal((await essai('10.0.0.1')).status, 200);
    assert.equal((await essai('10.0.0.1')).status, 429, '4e essai du MEME client : limite');
    // Une AUTRE famille sur la meme adresse serveur n'est pas bloquee :
    assert.equal((await essai('10.0.0.2')).status, 200, 'compteur independant par famille, pas global');
    assert.equal((await essai('10.0.0.3')).status, 200);
    // Sans en-tete (acces local direct) : IP de socket, non bloquee par les autres.
    assert.equal((await essai(null)).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});