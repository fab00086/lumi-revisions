// Mise a jour automatique : la version est detectee toute seule, mais le
// rechargement n'a lieu QUE hors lecon (ecran des profils, aucune fenetre
// ouverte) — jamais pendant une lecon ou un quiz en cours.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const update = fs.readFileSync(path.join(__dirname, '../public/update.js'), 'utf8');
const slice = update.slice(
  update.indexOf('function lumiEnLecon()'),
  update.indexOf('async function updateSavika()')
);

function ctx({ enLecon = false, modal = false, pending = true }) {
  const etat = { replaced: null, toasted: null };
  const c = vm.createContext({
    lumiUpdatePending: pending, lumiReloading: false,
    document: {
      // lumiEnLecon() regarde si #screen-chat a la classe 'hidden'.
      getElementById: (id) => (id === 'screen-chat' ? { classList: { contains: (cls) => (cls === 'hidden' ? !enLecon : false) } } : null),
      querySelector: () => (modal ? {} : null)
    },
    window: { location: { pathname: '/', replace: (u) => { etat.replaced = u; }, reload: () => { etat.replaced = 'reload'; } } },
    toast: (t) => { etat.toasted = t; },
    setTimeout: (fn) => { fn(); }
  });
  vm.runInContext(slice, c);
  return { c, etat };
}

test('mise a jour auto : JAMAIS pendant une lecon ni avec une fenetre ouverte', () => {
  let f = ctx({ enLecon: true });
  f.c.lumiMiseAJourHorsLecon();
  assert.equal(f.etat.replaced, null, 'aucun rechargement pendant la lecon');
  assert.equal(f.etat.toasted, null);

  f = ctx({ modal: true });
  f.c.lumiMiseAJourHorsLecon();
  assert.equal(f.etat.replaced, null, 'aucun rechargement avec une fenetre ouverte');
});

test('mise a jour auto : s applique sur l ecran des profils (message puis rechargement)', () => {
  const f = ctx({ pending: true });
  f.c.lumiMiseAJourHorsLecon();
  assert.match(String(f.etat.toasted), /Mise à jour de Savika/);
  assert.match(String(f.etat.replaced), /^\/\?_maj=\d+$/);
});

test('mise a jour auto : rien quand tout est deja a jour', () => {
  const f = ctx({ pending: false });
  f.c.lumiMiseAJourHorsLecon();
  assert.equal(f.etat.replaced, null);
  assert.equal(f.etat.toasted, null);
});
