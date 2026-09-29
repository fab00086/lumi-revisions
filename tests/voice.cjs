const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function section(a, b) { return source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a))); }
function setup() {
  const elements = new Map(), timers = new Map(), bubbles = [], spoken = [], sessions = [];
  let timerId = 0, gesture = false;
  const $ = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { value: '', handlers: {}, classList: {
        add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
      }, addEventListener: function (type, fn) { this.handlers[type] = fn; } });
    }
    return elements.get(id);
  };
  class Recognition {
    constructor() { sessions.push(this); }
    start() { assert.ok(gesture, 'start doit rester dans le clic'); }
    abort() { this.aborted = true; if (this.onend) this.onend(); }
  }
  const synth = { cancel() {}, speak(u) { spoken.push({ utterance: u, gesture }); } };
  const c = vm.createContext({ $, navigator: { userAgent: 'iPhone' },
    document: { addEventListener() {} },
    window: { webkitSpeechRecognition: Recognition, isSecureContext: true, speechSynthesis: synth },
    speechSynthesis: synth, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    cleanForSpeech: String, pickBestVoice: () => null, voiceRate: 1,
    chatGeneration: 0, chatLoading: false, activeChat: null, archiving: false,
    setStatus(text) { c.status = text; }, addBubble(role, text) { bubbles.push(text); },
    send(text) { c.sent = text; },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(section('// Un vrai bouton', '// ---------- Caméra'), c);
  vm.runInContext(section('// ---------- Micro (voix)', '// ---------- Envoi'), c);
  const click = id => { gesture = true; try { $(id).handlers.click(); } finally { gesture = false; } };
  return { c, $, click, timers, bubbles, spoken, sessions };
}
test('voix : le bouton parle pendant le clic, sans délai ni énoncé muet', () => {
  const t = setup(); t.click('btn-test-voice');
  assert.ok(t.spoken.length); assert.ok(t.spoken.every(s => s.gesture && s.utterance.text.trim()));
  t.spoken[0].utterance.onstart(); assert.equal(t.timers.size, 0);
});
test('voix refusée : propose la lecture manuelle et ignore les anciens événements', () => {
  const t = setup(); t.c.speak('Réponse automatique.');
  t.spoken[0].utterance.onerror(); assert.match(t.c.status, /Écouter Lumi/);
  t.click('btn-listen'); t.spoken[1].utterance.onstart();
  t.spoken[0].utterance.onend(); assert.match(t.c.status, /Je parle/);
  assert.equal(t.spoken[1].utterance.text, 'Réponse automatique.');
});
test('voix sans événement : sort de l’attente', () => {
  const t = setup(); t.c.speak('Bonjour.'); [...t.timers.values()][0]();
  assert.match(t.c.status, /Écouter Lumi/);
});
test('micro : démarre dans le clic et renouvelle la session après un arrêt', () => {
  const t = setup(); t.click('btn-mic'); const old = t.sessions[0];
  t.click('btn-mic'); assert.ok(old.aborted); t.click('btn-mic');
  assert.equal(t.sessions.length, 2); old.onresult({ results: [[{ transcript: 'ancien' }]] });
  assert.equal(t.c.sent, undefined);
  t.sessions[1].onresult({ results: [[{ transcript: 'bonjour' }]] });
  assert.equal(t.c.sent, 'bonjour'); assert.equal(t.timers.size, 0);
});
test('micro : permission refusée affiche une aide iPhone (QR code, pas de certificat)', () => {
  const t = setup(); t.click('btn-mic'); t.sessions[0].onerror({ error: 'not-allowed' });
  assert.match(t.bubbles[0], /QR code/); assert.match(t.bubbles[0], /Dictée/);
  assert.equal(t.$('btn-mic').classList.contains('recording'), false);
});
test('micro sans événement : arrêt et message après le délai', () => {
  const t = setup(); t.click('btn-mic'); [...t.timers.values()][0]();
  assert.ok(t.sessions[0].aborted); assert.match(t.bubbles[0], /dictée du clavier/);
});
test('micro : un résultat tardif ne passe pas dans un autre profil', () => {
  const t = setup(); t.click('btn-mic'); t.c.chatGeneration++;
  t.sessions[0].onresult({ results: [[{ transcript: 'ancienne question' }]] });
  assert.equal(t.c.sent, undefined); t.c.stopListening();
});
test('la lecture arrête le micro avant de parler', () => {
  const t = setup(); t.click('btn-mic'); t.click('btn-test-voice');
  assert.ok(t.sessions[0].aborted); assert.equal(t.$('btn-mic').classList.contains('recording'), false);
});
