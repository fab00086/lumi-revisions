const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function makeStorage() {
  const store = new Map();
  return { store, getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
}
function setup(ios, installed = false, storage = makeStorage()) {
  const elements = new Map(), handlers = {};
  const $ = id => {
    if (!elements.has(id)) {
      const classes = new Set(id === 'install-banner' ? ['hidden'] : []);
      elements.set(id, { classes, handlers: {}, textContent: '', innerHTML: '',
        addEventListener(name, fn) { this.handlers[name] = fn; },
        classList: { add: x => classes.add(x), remove: x => classes.delete(x),
          contains: x => classes.has(x),
          toggle(x, on) { if (on) classes.add(x); else classes.delete(x); } } });
    }
    return elements.get(id);
  };
  const c = vm.createContext({ $, isIOS: ios, navigator: {}, localStorage: storage, window: {
    addEventListener(name, fn) { handlers[name] = fn; },
    matchMedia: () => ({ matches: installed }) } });
  vm.runInContext(app.slice(app.indexOf('// ---------- Installation'), app.indexOf('// ---------- Test de sortie')), c);
  return { $, c, handlers, storage };
}
test('installation iPhone : guide Safari sans prétendre installer automatiquement', () => {
  const t = setup(true); t.$('btn-install').handlers.click();
  assert.match(t.$('install-steps').innerHTML, /Safari/);
  assert.match(t.$('install-steps').innerHTML, /Partager/);
  assert.ok(t.$('btn-install-native').classes.has('hidden'));
});
test('installation native : demande après un toucher, puis respecte le refus', async () => {
  const t = setup(false); let calls = 0;
  t.handlers.beforeinstallprompt({ preventDefault() {}, prompt: async () => calls++,
    userChoice: Promise.resolve({ outcome: 'dismissed' }) });
  assert.equal(calls, 0);
  t.$('btn-install').handlers.click();
  assert.ok(!t.$('btn-install-native').classes.has('hidden'));
  await t.$('btn-install-native').handlers.click();
  assert.equal(calls, 1);
  assert.match(t.$('install-intro').textContent, /plus tard/);
});
test('bannière : proposée une fois, puis mémorisée après fermeture', () => {
  const t = setup(false);
  t.c.maybeShowInstallBanner(0);
  assert.ok(!t.$('install-banner').classes.has('hidden'));
  assert.equal(t.storage.getItem('lumi-install-banner'), 'vu');
  t.$('btn-install-banner-dismiss').handlers.click();
  assert.ok(t.$('install-banner').classes.has('hidden'));
  const again = setup(false, false, t.storage);
  again.c.maybeShowInstallBanner(0);
  assert.ok(again.$('install-banner').classes.has('hidden'));
});
test('bannière : sur iPhone, « Installer » ouvre le guide Safari et se referme', () => {
  const t = setup(true);
  t.c.maybeShowInstallBanner(0);
  assert.ok(!t.$('install-banner').classes.has('hidden'));
  t.$('btn-install-banner-action').handlers.click();
  assert.ok(t.$('install-banner').classes.has('hidden'));
  assert.match(t.$('install-steps').innerHTML, /Safari/);
});
test('bannière : jamais proposée sur une app déjà installée', () => {
  const t = setup(false, true);
  t.c.maybeShowInstallBanner(0);
  assert.ok(t.$('install-banner').classes.has('hidden'));
  assert.equal(t.storage.getItem('lumi-install-banner'), null);
});
