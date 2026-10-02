const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function section(a, b) { return source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a))); }
function setup() {
  const elements = new Map(), timers = new Map(), bubbles = [], spoken = [], sessions = [], documentHandlers = {};
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
    start() { this.startedInGesture = gesture; }
    abort() { this.aborted = true; if (this.onend) this.onend(); }
  }
  const synth = { paused: false, resumedInGesture: false, cancel() {},
    resume() { this.paused = false; this.resumedInGesture = gesture; },
    speak(u) { spoken.push({ utterance: u, gesture, paused: this.paused }); } };
  const c = vm.createContext({ $, navigator: { userAgent: 'iPhone' },
    document: { hidden: false, addEventListener(type, fn) { documentHandlers[type] = fn; } },
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
  const click = id => { gesture = true; try { $(id).handlers.click(); documentHandlers.click?.(); } finally { gesture = false; } };
  return { c, $, click, timers, bubbles, spoken, sessions, documentHandlers, synth };
}

test('voix iPhone : le bouton reprend une synthèse en pause dans le toucher', () => {
  const t = setup(); t.synth.paused = true;
  t.click('btn-listen');
  assert.equal(t.synth.resumedInGesture, true);
  assert.equal(t.spoken[0].paused, false);
  assert.equal(t.spoken[0].utterance.volume, 1);
});
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
  assert.ok(old.startedInGesture, 'start doit rester dans le clic');
  t.click('btn-mic'); assert.ok(old.aborted); t.click('btn-mic');
  assert.equal(t.sessions.length, 2); old.onresult({ results: [[{ transcript: 'ancien' }]] });
  assert.equal(t.c.sent, undefined);
  t.sessions[1].onresult({ results: [[{ transcript: 'bonjour' }]] });
  assert.equal(t.c.sent, 'bonjour'); assert.equal(t.timers.size, 0);
});
test('mode discussion : le micro se rouvre tout seul et s’éteint au bouton', () => {
  const t = setup(); t.click('btn-mic-live');
  assert.ok(t.$('btn-mic-live').classList.contains('live'));
  assert.equal(t.sessions.length, 1); assert.ok(t.sessions[0].startedInGesture);
  t.sessions[0].onend(); // iOS coupe la session
  assert.equal(t.sessions.length, 1); // pas encore : petit délai
  [...t.timers.values()].forEach(fn => fn());
  assert.equal(t.sessions.length, 2); // rouvert tout seul
  t.click('btn-mic-live'); // éteint
  assert.ok(!t.$('btn-mic-live').classList.contains('live'));
  const n = t.sessions.length;
  [...t.timers.values()].forEach(fn => fn());
  assert.equal(t.sessions.length, n); // plus de renouvellement
});
test('mode discussion : le micro reprend après la lecture de Lumi', () => {
  const t = setup(); t.click('btn-mic-live');
  t.c.speak('Réponse de Lumi.'); // la lecture coupe le micro
  assert.ok(t.sessions[0].aborted);
  t.spoken[t.spoken.length - 1].utterance.onstart();
  t.spoken[t.spoken.length - 1].utterance.onend(); // Lumi a fini de parler
  [...t.timers.values()].forEach(fn => fn());
  assert.equal(t.sessions.length, 2); // le micro s'est rouvert tout seul
  assert.ok(t.$('btn-mic-live').classList.contains('live'));
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
test('premier toucher du micro : aucun son muet concurrent', () => {
  const t = setup(); t.click('btn-mic');
  assert.equal(t.spoken.length, 0);
  assert.ok(t.sessions[0].startedInGesture);
  assert.equal(t.documentHandlers.touchend, undefined);
});
test('mode discussion bloqué : le délai arrête le mode, sans relance infinie', () => {
  const t = setup(); t.click('btn-mic-live'); [...t.timers.values()][0]();
  assert.equal(t.$('btn-mic-live').classList.contains('live'), false);
  assert.equal(t.sessions.length, 1);
  assert.equal(t.timers.size, 0);
  assert.match(t.bubbles[0], /Appuie à nouveau/);
});
test('mode discussion : trois sessions vides demandent un nouveau toucher', () => {
  const t = setup(); t.click('btn-mic-live');
  for (let i = 0; i < 3; i++) {
    t.sessions.at(-1).onend();
    if (i < 2) { const [id, fn] = [...t.timers.entries()][0]; t.timers.delete(id); fn(); }
  }
  assert.equal(t.sessions.length, 3);
  assert.equal(t.$('btn-mic-live').classList.contains('live'), false);
  assert.equal(t.timers.size, 0);
});
test('mode discussion : un chargement ne peut pas activer un micro fantôme', () => {
  const t = setup(); t.c.chatLoading = true; t.click('btn-mic-live');
  assert.equal(t.sessions.length, 0);
  assert.equal(t.$('btn-mic-live').classList.contains('live'), false);
});
test('iPhone en arrière-plan : coupe micro et voix, ignore un résultat tardif', () => {
  const t = setup(); t.click('btn-mic-live');
  t.c.document.hidden = true; t.documentHandlers.visibilitychange();
  assert.ok(t.sessions[0].aborted);
  t.sessions[0].onresult({ results: [[{ transcript: 'ancienne question' }]] });
  assert.equal(t.c.sent, undefined);
  assert.equal(t.timers.size, 0);
  t.click('btn-mic'); assert.equal(t.sessions.length, 1);
});
test('les deux boutons : 🎤 arrête complètement une discussion active', () => {
  const t = setup(); t.click('btn-mic-live'); t.click('btn-mic');
  assert.ok(t.sessions[0].aborted);
  assert.equal(t.$('btn-mic-live').classList.contains('live'), false);
  t.c.micLiveResume();
  assert.equal(t.timers.size, 0);
  t.click('btn-mic'); assert.equal(t.sessions.length, 2);
  assert.ok(t.sessions[1].startedInGesture);
});
test('les deux boutons : 🎙️ remplace une dictée par une nouvelle session dans le toucher', () => {
  const t = setup(); t.click('btn-mic'); t.click('btn-mic-live');
  assert.ok(t.sessions[0].aborted); assert.equal(t.sessions.length, 2);
  assert.ok(t.sessions[1].startedInGesture);
  t.sessions[0].onerror({error:'aborted'});
  assert.ok(t.$('btn-mic-live').classList.contains('live'));
});
test('🎤 passe directement à une question pendant la voix du mode discussion', () => {
  const t = setup(); t.click('btn-mic-live'); t.c.speak('Je réponds.');
  t.click('btn-mic');
  assert.equal(t.$('btn-mic-live').classList.contains('live'), false);
  assert.equal(t.sessions.length, 2); assert.ok(t.sessions[1].startedInGesture);
});
test('mode discussion : une reprise pendant la préparation de la voix ne coupe pas la réponse', () => {
  const t = setup(); t.click('btn-mic-live'); t.c.speak('Réponse de Lumi.');
  const count=t.sessions.length;
  t.c.micLiveResume();
  t.spoken.at(-1).utterance.onstart(); // retire le délai de préparation
  assert.equal(t.timers.size, 0); assert.equal(t.sessions.length, count);
  t.spoken.at(-1).utterance.onend();
  assert.equal(t.timers.size, 1);
});
test('une dictée : ignore les résultats intermédiaires et un doublon final', () => {
  const t = setup(); let sends=0;t.c.send=()=>sends++;
  t.click('btn-mic'); const session=t.sessions[0];
  const interim=[{transcript:'question incomplète'}];interim.isFinal=false;
  session.onresult({results:[interim]});assert.equal(sends,0);
  const final=[{transcript:'question complète'}];final.isFinal=true;
  session.onresult({results:[final]});session.onresult({results:[final]});
  assert.equal(sends,1);
});
