const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function setup(ios, installed = false) {
  const elements = new Map(), handlers = {};
  const $ = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { classes, handlers: {}, textContent: '', innerHTML: '',
        addEventListener(name, fn) { this.handlers[name] = fn; },
        classList: { add: x => classes.add(x), remove: x => classes.delete(x),
          toggle(x, on) { if (on) classes.add(x); else classes.delete(x); } } });
    }
    return elements.get(id);
  };
  const c = vm.createContext({ $, isIOS: ios, navigator: {}, window: {
    addEventListener(name, fn) { handlers[name] = fn; },
    matchMedia: () => ({ matches: installed }) } });
  vm.runInContext(app.slice(app.indexOf('// ---------- Installation'), app.indexOf('// ---------- Test de sortie')), c);
  return { $, c, handlers };
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
