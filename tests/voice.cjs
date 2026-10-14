const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function section(a, b) { return source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a))); }
function setup(serverVoice = false, blockedSilent = false, blockedAuto = false, seed = {}) {
  const elements = new Map(), timers = new Map(), bubbles = [], spoken = [], sessions = [], documentHandlers = {}, reminders = [];
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
    stop() { this.stopped = true; }
  }
  const synth = { paused: false, resumedInGesture: false, cancelled: 0, cancel() { this.cancelled++; },
    resume() { this.paused = false; this.resumedInGesture = gesture; },
    speak(u) { spoken.push({ utterance: u, gesture, paused: this.paused }); } };
  const audioPlays = [], audio = { src: '/audio-ready.wav', pause() { this.paused = true; }, play() {
    audioPlays.push({ gesture, src: this.src });
    if (blockedSilent && this.src === '/audio-ready.wav') return new Promise(()=>{});
    if (blockedAuto && this.src !== '/audio-ready.wav' && !gesture) return Promise.reject(Object.assign(Error('Toucher requis'),{name:'NotAllowedError'}));
    return Promise.resolve();
  } };
  const pendingVoices = [], voiceRequests = [];
  const location = { reload() { location.reloaded = (location.reloaded || 0) + 1; } };
  const sessionStorage = { store: new Map(), getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
    setItem(k, v) { this.store.set(k, String(v)); }, removeItem(k) { this.store.delete(k); } };
  const localStorage = { store: new Map(Object.entries(seed)), getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
    setItem(k, v) { this.store.set(k, String(v)); }, removeItem(k) { this.store.delete(k); } };
  // Dictée Whisper : faux MediaRecorder + micro + serveur de transcription.
  const recorders = [], transcribeBodies = [];
  class MediaRecorderMock {
    constructor(stream, opts) { this.stream = stream; this.mimeType = (opts && opts.mimeType) || ''; this.state = 'inactive'; this.ondataavailable = null; this.onstop = null; recorders.push(this); }
    static isTypeSupported(t) { return String(t).startsWith('audio/webm') || t === 'audio/mp4'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      if (this.ondataavailable) this.ondataavailable({ data: new Blob(['faux-son'], { type: this.mimeType || 'audio/webm' }) });
      if (this.onstop) this.onstop();
    }
  }
  const fakeStream = { getTracks: () => [{ stopped: 0, stop() { this.stopped++; } }] };
  // Le micro n'est « disponible » que sur demande (tests Whisper) : sans lui,
  // les chemins historiques démarrent la session dans le clic, comme avant.
  const enableMic = () => { c.navigator.mediaDevices = { getUserMedia: async () => fakeStream }; };
  const c = vm.createContext({ $, navigator: { userAgent: 'iPhone' }, location, sessionStorage, localStorage,
    voiceMode: serverVoice ? 'server' : 'native', AbortController, Blob, btoa, MediaRecorder: MediaRecorderMock,
    Audio: class { constructor() { return audio; } },
    URL: { createObjectURL: () => '/api/speech/audio/'+'a'.repeat(48), revokeObjectURL() {} },
    fetch: (url, options) => {
      // Dictée Whisper (PC) : statut et transcription répondent tout de suite.
      if (url === '/api/transcribe/status') return Promise.resolve({ ok: true, json: async () => ({ available: true, model: 'small' }) });
      if (url === '/api/transcribe' && options && options.method === 'POST') {
        transcribeBodies.push(JSON.parse(options.body));
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, texte: 'bonjour les enfants' }) });
      }
      return new Promise(resolve => { voiceRequests.push({url,...options}); pendingVoices.push(resolve); });
    },
    document: { hidden: false, addEventListener(type, fn) { documentHandlers[type] = fn; } },
    window: { webkitSpeechRecognition: Recognition, isSecureContext: true, speechSynthesis: synth },
    speechSynthesis: synth, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    cleanForSpeech: String, pickBestVoice: () => null, voiceRate: 1,
    chatGeneration: 0, chatLoading: false, activeChat: null, archiving: false,
    setStatus(text) { c.status = text; }, addBubble(role, text) { bubbles.push(text); },
    toast(text) { reminders.push(text); },
    send(text) { c.sent = text; },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(section('// Un vrai bouton', '// ---------- Caméra'), c);
  vm.runInContext(section('// ---------- Micro (voix)', '// ---------- Envoi'), c);
  const click = id => { gesture = true; try { $(id).handlers.click(); documentHandlers.click?.(); } finally { gesture = false; } };
  return { c, $, click, timers, bubbles, spoken, sessions, documentHandlers, synth, audioPlays, audio, reminders,
    voiceRequests, location, sessionStorage, localStorage, recorders, transcribeBodies, enableMic,
    finishVoice: async (letter='a') => { pendingVoices.shift()({ ok: true, json: async () => ({url:'/api/speech/audio/'+letter.repeat(48)}) }); await new Promise(resolve => setImmediate(resolve)); } };
}

test('voix longue : première phrase jouée sans attendre la suite, micro repris après le dernier morceau',async()=>{
 const t=setup(true);t.click('btn-mic-live');
 const text='Imagine une pizza coupée en quatre parts égales pour partager ton goûter avec tes amis. Chaque part représente un quart. '+ 'Deux parts font une moitié. '.repeat(30);
 t.c.speak(text);assert.equal(t.voiceRequests.length,1);
 await t.finishVoice('a');assert.equal(t.voiceRequests.length,2);
 const parts=t.voiceRequests.map(r=>JSON.parse(r.body).text);
 assert.ok(parts[0].length<=320);assert.equal(parts.join(' '),text.trim());
 assert.ok(t.audioPlays.some(p=>p.src.endsWith('a'.repeat(48))));
 assert.equal(t.$('voice-player').open,false);
 const next=t.audio.onended();assert.equal(t.sessions.length,1);
 await t.finishVoice('b');await next;assert.ok(t.audio.src.endsWith('b'.repeat(48)));
 assert.ok(t.timers.size<=1,'aucune relance micro pendant la lecture');await t.audio.onended();assert.equal(t.timers.size,1);
 assert.equal(t.$('voice-player').classList.contains('hidden'),true);
});

test('iPhone : lecture automatique refusée ouvre le secours, bouton Écouter joue le fichier prêt dans le toucher',async()=>{
 const t=setup(true,false,true);t.click('btn-test-voice');await t.finishVoice();
 assert.equal(t.$('voice-player').open,true);assert.match(t.c.status,/lecteur audio/);
 const requests=t.voiceRequests.length;t.click('btn-listen');await new Promise(r=>setImmediate(r));
 assert.equal(t.voiceRequests.length,requests);assert.equal(t.audioPlays.at(-1).gesture,true);
 assert.match(t.c.status,/Je parle/);assert.equal(t.$('voice-player').open,false);
});

test('voix longue : Stop pendant la préparation de la suite interdit une lecture tardive',async()=>{
 const t=setup(true);t.c.speak('Une phrase qui explique calmement la première étape du calcul, avec un exemple facile pour commencer. '+ 'La suite de la leçon. '.repeat(30));
 await t.finishVoice();const next=t.audio.onended();t.click('btn-stop');
 const plays=t.audioPlays.length;await t.finishVoice('b');await next;
 assert.equal(t.audioPlays.length,plays);assert.ok(!t.$('avatar').classList.contains('talking'));
});

test('iPhone : une suite bloquée se relance depuis le bouton sans répéter la première phrase',async()=>{
 const t=setup(true,false,true);
 t.c.speak('Une phrase qui explique calmement la première étape du calcul, avec un exemple facile pour commencer. '+ 'La suite de la leçon. '.repeat(30));
 await t.finishVoice('a');t.click('btn-listen');await new Promise(r=>setImmediate(r));
 const next=t.audio.onended();await t.finishVoice('b');await next;
 assert.equal(t.$('voice-player').open,true);
 t.click('btn-listen');await new Promise(r=>setImmediate(r));
 assert.ok(t.audioPlays.at(-1).src.endsWith('b'.repeat(48)));assert.equal(t.audioPlays.at(-1).gesture,true);
 assert.equal(t.voiceRequests.length,2);await t.audio.onended();
 assert.equal(t.$('voice-player').classList.contains('hidden'),true);
});

test('voix fichier : active la sortie dans le toucher, lit la réponse et reprend le micro après la fin', async () => {
  const t = setup(true); t.click('btn-mic-live');
  t.click('btn-test-voice');
  assert.equal(t.audioPlays[0].gesture, true);
  assert.equal(t.spoken.length, 0);
 await new Promise(resolve => setImmediate(resolve));
 t.c.micLiveResume();
 assert.equal(t.sessions.length, 1, 'pas de nouveau micro pendant la préparation');
 await t.finishVoice();
 assert.equal(t.audio.src, '/api/speech/audio/'+'a'.repeat(48)); assert.match(t.c.status, /Je parle/);
 t.c.micLiveResume(); assert.equal(t.sessions.length, 1, 'la session vivante continue pendant la lecture');
 t.audio.onended(); assert.equal(t.timers.size, 1, 'reprise confirmée après la voix');
});

test('voix mobile : un déverrouillage sonore bloqué ne bloque pas la génération ni le lecteur visible',async()=>{
 const t=setup(true,true);t.click('btn-test-voice');await t.finishVoice();
 assert.equal(t.audio.src,'/api/speech/audio/'+'a'.repeat(48));assert.equal(t.audio.controls,true);assert.equal(t.audio.hidden,false);assert.equal(t.audio.muted,false);assert.match(t.c.status,/Je parle/);
});

test('voix fichier : Stop ignore une réponse tardive, et une deuxième lecture utilise le fichier dans le toucher', async () => {
  const t = setup(true); t.click('btn-test-voice'); await new Promise(resolve => setImmediate(resolve));
  t.click('btn-stop'); await t.finishVoice(); assert.ok(!t.$('avatar').classList.contains('talking'));
  t.click('btn-test-voice'); await new Promise(resolve => setImmediate(resolve)); await t.finishVoice();
  t.click('btn-stop'); t.click('btn-listen');
  assert.equal(t.audioPlays.at(-1).src, '/api/speech/audio/'+'a'.repeat(48)); assert.equal(t.audioPlays.at(-1).gesture, true);
  await new Promise(resolve => setImmediate(resolve));
});

test('micro mobile : aucune lecture audio concurrente au démarrage du micro',()=>{
 const t=setup(true);t.click('btn-mic');assert.equal(t.audioPlays.length,0);assert.equal(t.sessions.length,1);
});

test('micro : la fin de parole demande le résultat final sans abandonner la phrase',()=>{
 const t=setup();vm.runInContext('dictationReview = false',t.c);t.click('btn-mic');const session=t.sessions[0];session.onspeechend();assert.equal(session.stopped,true);assert.equal(session.aborted,undefined);
 session.onresult({results:[[{transcript:'Ma question'}]]});assert.equal(t.c.sent,'Ma question');
});

test('voix iPhone : le bouton reprend une synthèse en pause dans le toucher', () => {
  const t = setup(); t.synth.paused = true;
  t.click('btn-listen');
  assert.equal(t.synth.resumedInGesture, true);
  assert.equal(t.spoken[0].paused, false);
  assert.equal(t.spoken[0].utterance.volume, 1);
});

test('voix Safari : premier toucher ne vide pas une file déjà vide, et respecte la langue de la voix choisie',()=>{
 const t=setup();t.c.pickBestVoice=()=>({name:'Amélie',lang:'fr-CA'});
 t.click('btn-test-voice');assert.equal(t.synth.cancelled,0);assert.equal(t.spoken[0].utterance.lang,'fr-CA');
 t.synth.pending=true;t.click('btn-stop');assert.equal(t.synth.cancelled,1);
});

test('voix mobile : laisse le téléphone choisir, sans forcer une voix distante', () => {
  const remote = { name: 'French online', lang: 'fr-FR' };
  const c = vm.createContext({ navigator: { userAgent: 'iPhone' },
    voicePref: null, frenchVoices: () => [remote] });
  vm.runInContext(section('function pickBestVoice()', 'function populateVoiceSelect()'), c);
  assert.equal(c.pickBestVoice(), null);
  c.navigator.userAgent = 'Android';
  assert.equal(c.pickBestVoice(), null);
  c.voicePref = remote.name;
  assert.equal(c.pickBestVoice(), remote, 'le choix explicite reste respecté');
  c.voicePref = '__auto__';
  assert.equal(c.pickBestVoice(), null);
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
  const t = setup(); vm.runInContext('dictationReview = false', t.c); t.click('btn-mic'); const old = t.sessions[0];
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
test('mode discussion : le micro reste ouvert pendant la lecture de Lumi', () => {
  const t = setup(); t.click('btn-mic-live');
  t.c.speak('Réponse de Lumi.'); // le micro n'est plus coupé pendant la voix
  assert.equal(t.sessions[0].aborted, undefined);
  t.spoken[t.spoken.length - 1].utterance.onstart();
  t.spoken[t.spoken.length - 1].utterance.onend(); // Lumi a fini de parler
  [...t.timers.values()].forEach(fn => fn());
  assert.equal(t.sessions.length, 1, 'la session vivante continue, sans re-création');
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
test('mode discussion : une session Safari bloquée se relance sans désactiver le bouton', () => {
  const t = setup(); t.click('btn-mic-live'); [...t.timers.values()][0]();
  assert.equal(t.$('btn-mic-live').classList.contains('live'), true);
  assert.equal(t.sessions.length, 1);
  assert.equal(t.timers.size, 1);
  assert.match(t.c.status, /se relance/);
  const [id, fn] = [...t.timers.entries()][0]; t.timers.delete(id); fn();
  assert.equal(t.sessions.length, 2);
  t.click('btn-mic-live'); assert.equal(t.timers.size, 0);
});
test('mode discussion : les silences successifs ne désactivent jamais le bouton', () => {
  const t = setup(); t.click('btn-mic-live');
  for (let i = 0; i < 12; i++) {
    t.sessions.at(-1).onend();
    const [id, fn] = [...t.timers.entries()][0]; t.timers.delete(id); fn();
  }
  assert.equal(t.sessions.length, 13);
  assert.equal(t.$('btn-mic-live').classList.contains('live'), true);
  assert.equal(t.timers.size, 1);
  t.sessions.at(-1).onresult({results:[[{transcript:'Je suis prête'}]]});
  assert.equal(t.c.sent,'Je suis prête');
});

test('mode discussion : no-speech et arrêt Safari inattendu relancent, une permission refusée arrête',()=>{
 const t=setup();t.click('btn-mic-live');
 for(const error of ['no-speech','aborted']){
  t.sessions.at(-1).onerror({error});assert.equal(t.$('btn-mic-live').classList.contains('live'),true);
  const [id,fn]=[...t.timers.entries()][0];t.timers.delete(id);fn();
 }
 t.sessions.at(-1).onerror({error:'not-allowed'});
 assert.equal(t.$('btn-mic-live').classList.contains('live'),false);assert.equal(t.timers.size,0);
});

test('mode discussion : une phrase intermédiaire ne compte pas comme un silence',()=>{
 const t=setup();t.click('btn-mic-live');
 const result=[{transcript:'Je réfléchis'}];result.isFinal=false;t.sessions[0].onresult({results:[result]});
 t.sessions[0].onend();assert.equal(vm.runInContext('emptyMicSessions',t.c),0);assert.equal(t.c.sent,undefined);
});

test('verrou écran : demande tardive après arrêt libérée, aucune double demande',async()=>{
 const t=setup();let resolve;let requests=0;let releases=0;
 t.c.navigator.wakeLock={request:()=>{requests++;return new Promise(r=>{resolve=r;});}};
 t.click('btn-mic-live');t.c.keepScreenAwake(true);assert.equal(requests,1);
 t.click('btn-mic-live');resolve({released:false,release:async()=>{releases++;},addEventListener(){}});
 await new Promise(r=>setImmediate(r));assert.equal(releases,1);assert.equal(vm.runInContext('wakeLock',t.c),null);
});

test('verrou écran : libération système permet une nouvelle acquisition, erreur micro libère le verrou',async()=>{
 const t=setup();const locks=[];
 t.c.navigator.wakeLock={request:async()=>{const lock={released:false,release:async function(){this.released=true;this.onrelease?.();},addEventListener(type,fn){this.onrelease=fn;}};locks.push(lock);return lock;}};
 t.click('btn-mic-live');await new Promise(r=>setImmediate(r));
 await locks[0].release();await t.c.keepScreenAwake(true);assert.equal(locks.length,2);
 t.sessions[0].onerror({error:'not-allowed'});await new Promise(r=>setImmediate(r));assert.equal(locks[1].released,true);
});

test('verrou écran : refus du téléphone ne désactive pas la conversation',async()=>{
 const t=setup();t.c.navigator.wakeLock={request:async()=>{throw Error('Refus système');}};
 t.click('btn-mic-live');await new Promise(r=>setImmediate(r));
 assert.equal(t.$('btn-mic-live').classList.contains('live'),true);assert.equal(t.sessions.length,1);
});

test('conversation iPhone : rappel mode silencieux une fois, sans bloquer le micro',()=>{
 const t=setup();t.click('btn-mic-live');assert.equal(t.sessions.length,1);assert.equal(t.reminders.length,1);
 assert.match(t.reminders[0],/désactive le mode silencieux/);t.click('btn-mic-live');t.click('btn-mic-live');
 assert.equal(t.reminders.length,1);assert.equal(t.sessions.length,2);
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
test('🎤 pendant la voix du mode discussion : coupe la discussion, second appui pour dicter', () => {
  const t = setup(); t.click('btn-mic-live'); t.c.speak('Je réponds.');
  t.click('btn-mic');
  assert.equal(t.$('btn-mic-live').classList.contains('live'), false);
  assert.ok(t.sessions[0].aborted, 'la session de discussion est arrêtée proprement');
  assert.equal(t.sessions.length, 1);
  t.click('btn-mic');
  assert.equal(t.sessions.length, 2); assert.ok(t.sessions[1].startedInGesture);
});
test('mode discussion : une reprise pendant la préparation de la voix ne coupe pas la réponse', () => {
  const t = setup(); t.click('btn-mic-live'); t.c.speak('Réponse de Lumi.');
  const count=t.sessions.length;
  t.c.micLiveResume();
  t.spoken.at(-1).utterance.onstart(); // retire le délai de préparation
  assert.equal(t.sessions.length, count, 'aucune nouvelle session pendant la préparation');
  t.spoken.at(-1).utterance.onend();
  assert.equal(t.timers.size, 1);
});
test('une dictée : ignore les résultats intermédiaires et un doublon final', () => {
  const t = setup(); vm.runInContext('dictationReview = false', t.c); let sends=0;t.c.send=()=>sends++;
  t.click('btn-mic'); const session=t.sessions[0];
  const interim=[{transcript:'question incomplète'}];interim.isFinal=false;
  session.onresult({results:[interim]});assert.equal(sends,0);assert.equal(t.$('input').value,'question incomplète');
  const final=[{transcript:'question complète'}];final.isFinal=true;
  session.onresult({results:[final]});session.onresult({results:[final]});
  assert.equal(sends,1);
});

test('micro actif : chaque résultat renouvelle la surveillance sans couper la phrase',()=>{
 const t=setup();t.click('btn-mic-live');const session=t.sessions[0];const original=[...t.timers.keys()][0];
 const interim=[{transcript:'Une explication longue'}];interim.isFinal=false;
 session.onresult({results:[interim]});assert.equal(t.timers.has(original),false);assert.equal(session.aborted,undefined);
 const next=[...t.timers.keys()][0];session.onspeechstart();assert.equal(t.timers.has(next),false);
 const final=[{transcript:'Une explication longue et complète'}];final.isFinal=true;
 session.onresult({results:[final]});assert.equal(t.c.sent,'Une explication longue et complète');
});
test('micro interrompu : début conservé, continuation assemblée et validation manuelle',()=>{
 const t=setup();t.click('btn-mic-live');const result=[{transcript:'Combien font vingt plus'}];result.isFinal=false;
 t.sessions[0].onresult({results:[result]});t.sessions[0].onend();
 const [id,fn]=[...t.timers.entries()][0];t.timers.delete(id);fn();
 const final=[{transcript:'trente'}];final.isFinal=true;t.sessions[1].onresult({results:[final]});
 assert.equal(t.$('input').value,'Combien font vingt plus trente');assert.equal(t.c.sent,undefined);
 assert.match(t.c.status,/vérifie-la.*Envoyer/);t.c.micLiveResume();assert.equal(t.timers.size,0);
});
test('micro : brouillon tapé conservé quand on ajoute une dictée',()=>{
 const t=setup();t.$('input').value='Mon exercice :';t.click('btn-mic');
 t.sessions[0].onresult({results:[[{transcript:'calculer une moitié'}]]});
 assert.equal(t.$('input').value,'Mon exercice : calculer une moitié');assert.equal(t.c.sent,undefined);
});
test('micro dictée : blocage après résultat intermédiaire garde le texte sans envoi',()=>{
 const t=setup();t.click('btn-mic');const result=[{transcript:'Mon début de question'}];result.isFinal=false;
 t.sessions[0].onresult({results:[result]});const [id,fn]=[...t.timers.entries()][0];t.timers.delete(id);fn();
 assert.equal(t.$('input').value,'Mon début de question');assert.equal(t.c.sent,undefined);assert.match(t.c.status,/Phrase conservée/);
});
test('iPhone mode discussion : le micro reste vivant pendant la voix et l’enfant peut couper Lumi',async()=>{
 const t=setup(true);t.click('btn-mic-live');t.c.speak('Une réponse.');await t.finishVoice();t.audio.onplay();
 assert.equal(t.sessions.length,1);assert.equal(t.sessions[0].aborted,undefined);
 assert.equal(vm.runInContext('voiceAudioBusy',t.c),true);
 t.sessions[0].onresult({results:[[{transcript:'Attends Lumi'}]]});
 assert.equal(t.audio.paused,true,'Lumi se tait immédiatement');
 assert.equal(vm.runInContext('voiceAudioBusy',t.c),false);
 assert.equal(t.c.sent,'Attends Lumi','la phrase de l’enfant part à Lumi');
});
test('lecteur : pause de fin ou événement tardif après Stop ne relance pas une ancienne voix',async()=>{
 const t=setup(true);t.click('btn-mic-live');t.c.speak('Une réponse.');await t.finishVoice();const oldPause=t.audio.onpause;
 t.audio.paused=true;t.audio.ended=true;oldPause();assert.equal(vm.runInContext('voiceAudioBusy',t.c),true);
 t.click('btn-stop');assert.equal(t.audio.onpause,null);const before=t.timers.size;oldPause();assert.equal(t.timers.size,before);
});

test('dictée : ponctuation dictée convertie, espaces propres, mots de maths intacts', () => {
  const c = vm.createContext({});
  vm.runInContext(section('function tidyDictation(', 'function stopListening'), c);
  assert.equal(c.tidyDictation('quel est le résultat  point d’interrogation'), 'quel est le résultat ?');
  assert.equal(c.tidyDictation('Bravo  point d’exclamation'), 'Bravo !');
  assert.equal(c.tidyDictation('ouvre la parenthèse trois plus cinq ferme la parenthèse'), '(trois plus cinq)');
  assert.equal(c.tidyDictation('  trop   d’espaces '), 'trop d’espaces');
  // Les mots des énoncés de maths ne sont jamais transformés.
  assert.equal(c.tidyDictation('place deux points A et B'), 'place deux points A et B');
  assert.equal(c.tidyDictation('trois virgule cinq'), 'trois virgule cinq');
  // Enfants : les hésitations disparaissent, pas les vrais mots.
  assert.equal(c.tidyDictation('euh combien font  heu  deux plus trois'), 'combien font deux plus trois');
  assert.equal(c.tidyDictation('quelle heure est-il hum'), 'quelle heure est-il');
  assert.equal(c.tidyDictation('humour et heureux'), 'humour et heureux');
  assert.equal(c.tidyDictation(''), '');
  assert.equal(c.tidyDictation(null), '');
});
test('mode discussion : après trois silences, un conseil gentil à l’enfant (une seule fois)', () => {
  const t = setup(); t.click('btn-mic-live');
  const restart = () => {
    const [id, fn] = [...t.timers.entries()][0]; t.timers.delete(id); fn();
  };
  t.sessions.at(-1).onend(); restart();
  assert.equal(t.bubbles.filter(x => /plus fort/.test(x)).length, 0, 'pas de reproche après un seul silence');
  t.sessions.at(-1).onend(); restart();
  t.sessions.at(-1).onend(); restart();
  assert.equal(t.bubbles.filter(x => /plus fort/.test(x)).length, 1);
  assert.match(t.bubbles.at(-1), /Approche le téléphone/);
  // Une phrase entendue remet le compteur à zéro, mais le conseil ne se répète pas.
  const ok = [{ transcript: 'ma question' }]; ok.isFinal = false;
  t.sessions.at(-1).onresult({ results: [ok] });
  assert.equal(vm.runInContext('emptyMicSessions', t.c), 0);
  for (let i = 0; i < 6; i++) { t.sessions.at(-1).onend(); restart(); }
  assert.equal(t.bubbles.filter(x => /plus fort/.test(x)).length, 1);
  assert.equal(t.$('btn-mic-live').classList.contains('live'), true);
});
test('dictée : le texte envoyé à Lumi est nettoyé (ponctuation parlée)', () => {
  const t = setup(); vm.runInContext('dictationReview = false', t.c); t.click('btn-mic');
  t.sessions[0].onresult({ results: [[{ transcript: 'c’est quoi les fractions point d’interrogation' }]] });
  assert.equal(t.c.sent, 'c’est quoi les fractions ?');
});
test('dictée iPhone : une session coupée puis reprise garde le début et la ponctuation finale', () => {
  const t = setup(); t.click('btn-mic-live');
  const result = [{ transcript: 'combien font vingt plus' }]; result.isFinal = false;
  t.sessions[0].onresult({ results: [result] });
  t.sessions[0].onend();
  const [id, fn] = [...t.timers.entries()][0]; t.timers.delete(id); fn();
  const final = [{ transcript: 'trente point d’interrogation' }]; final.isFinal = true;
  t.sessions[1].onresult({ results: [final] });
  assert.equal(t.$('input').value, 'combien font vingt plus trente ?');
  assert.equal(t.c.sent, undefined, 'phrase complétée soumise à relecture');
  assert.match(t.c.status, /vérifie-la/);
});

test('dictée : par défaut, Lumi propose la phrase à relire avant l’envoi', () => {
  const t = setup(); t.click('btn-mic');
  t.sessions[0].onresult({ results: [[{ transcript: 'combien font sept plus cinq' }]] });
  assert.equal(t.c.sent, undefined);
  assert.equal(t.$('input').value, 'combien font sept plus cinq');
  assert.equal(vm.runInContext('micDraftReview', t.c), true);
  assert.match(t.c.status, /vérifie-la.*Envoyer/);
  // Le mode Conversation reste mains libres : il envoie tout seul.
  const t2 = setup(); t2.click('btn-mic-live');
  t2.sessions[0].onresult({ results: [[{ transcript: 'combien font sept plus cinq' }]] });
  assert.equal(t2.c.sent, 'combien font sept plus cinq');
});
test('réglage : la relecture avant envoi se désactive et se retient', () => {
  const t = setup();
  assert.equal(vm.runInContext('dictationReview', t.c), true);
  assert.equal(t.$('dictation-review').checked, true);
  t.$('dictation-review').checked = false;
  t.$('dictation-review').handlers.change();
  assert.equal(vm.runInContext('dictationReview', t.c), false);
  assert.equal(t.localStorage.getItem('lumidictationreview'), '0');
  t.click('btn-mic');
  t.sessions[0].onresult({ results: [[{ transcript: 'une question' }]] });
  assert.equal(t.c.sent, 'une question');
});
test('push-to-talk : maintenir 🎤, parler, relâcher termine la dictée', () => {
  const t = setup();
  t.$('btn-mic').handlers.pointerdown({});
  const [id, fn] = [...t.timers.entries()][0]; t.timers.delete(id); fn(); // appui long
  assert.equal(t.sessions.length, 1);
  t.sessions[0].onstart();
  t.$('btn-mic').handlers.pointerup();
  assert.equal(t.sessions[0].stopped, true, 'relâcher demande le résultat final');
  // Le clic qui suit un appui long ne rouvre pas le micro.
  t.click('btn-mic');
  assert.equal(t.sessions.length, 1);
  t.sessions[0].onresult({ results: [[{ transcript: 'ma question' }]] });
  assert.equal(t.c.sent, undefined, 'relecture avant envoi (réglage par défaut)');
  assert.equal(t.$('input').value, 'ma question');
});
test('push-to-talk : appui court = dictée classique, relâche trop tôt = annulation propre', () => {
  const t = setup();
  t.$('btn-mic').handlers.pointerdown({});
  t.$('btn-mic').handlers.pointerup();
  assert.equal(t.sessions.length, 0);
  t.click('btn-mic');
  assert.equal(t.sessions.length, 1);
  assert.ok(t.sessions[0].startedInGesture);
  // Appui long puis relâche avant que la session démarre : rien ne traîne.
  const t2 = setup();
  t2.$('btn-mic').handlers.pointerdown({});
  const [id, fn] = [...t2.timers.entries()][0]; t2.timers.delete(id); fn();
  t2.$('btn-mic').handlers.pointerup();
  assert.equal(t2.sessions[0].aborted, true);
  assert.equal(vm.runInContext('recog', t2.c), null);
});

test('dictée Whisper : 🎤 enregistre, transcrit, propose la relecture', async () => {
  const t = setup(); await t.c.checkWhisperStt(); t.enableMic();
  assert.equal(vm.runInContext('whisperStt', t.c), true);
  t.click('btn-mic');
  for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r));
  assert.equal(t.recorders.length, 1);
  assert.equal(t.recorders[0].state, 'recording');
  assert.equal(t.sessions.length, 0, 'pas de reconnaissance navigateur quand Whisper est là');
  t.click('btn-mic'); // deuxième appui : je transcris
  for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));
  assert.equal(t.recorders[0].state, 'inactive');
  assert.equal(t.transcribeBodies.length, 1);
  assert.equal(t.transcribeBodies[0].mime, 'audio/webm;codecs=opus');
  assert.equal(t.$('input').value, 'bonjour les enfants');
  assert.equal(t.c.sent, undefined, 'relecture par défaut');
  assert.match(t.c.status, /transcrite/);
});
test('push-to-talk Whisper : maintenir 🎤 enregistre, relâcher transcrit', async () => {
  const t = setup(); await t.c.checkWhisperStt(); t.enableMic();
  t.$('btn-mic').handlers.pointerdown({});
  const [id, fn] = [...t.timers.entries()][0]; t.timers.delete(id); fn();
  for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r));
  assert.equal(t.recorders.length, 1);
  t.$('btn-mic').handlers.pointerup();
  for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));
  assert.equal(t.$('input').value, 'bonjour les enfants');
  t.click('btn-mic'); // le clic qui suit l'appui long est ignoré
  assert.equal(t.recorders.length, 1);
  assert.equal(t.sessions.length, 0, 'aucune session navigateur concurrente');
});

// « Le micro marche une fois puis plus jamais » : après la voix de Lumi,
// Safari garde le micro et les sessions démarrent puis meurent sans rien
// capter (audio-capture / aborted / mort en < 2,5 s). Ces morts anormales
// doivent déclencher la réparation auto (relance, puis recharge) — avant ce
// correctif, seules les sessions « jamais démarrées » la déclenchaient.
test('micro iPhone bloqué après la voix : relance puis recharge, avec reprise de la leçon', () => {
  const t = setup(); t.c.currentProfile = { id: 'manon', name: 'Manon' };
  t.click('btn-mic-live');
  t.sessions[0].onstart(); // le micro a déjà marché une fois sur la page
  t.sessions[0].onerror({ error: 'audio-capture' }); // Safari a repris le micro
  assert.equal(t.$('btn-mic-live').classList.contains('live'), true, 'la conversation reste active');
  const [id, fn] = [...t.timers.entries()][0]; t.timers.delete(id); fn();
  assert.equal(t.sessions.length, 2, 'une relance est tentée');
  t.sessions[1].onstart();
  t.sessions[1].onerror({ error: 'aborted' });
  const [id2, fn2] = [...t.timers.entries()][0]; t.timers.delete(id2); fn2();
  assert.equal(t.location.reloaded, 1, 'deuxième échec : recharge de secours');
  const flag = JSON.parse(t.sessionStorage.getItem('lumi-mic-repair'));
  assert.equal(flag.id, 'manon', 'la leçon en cours est notée pour reprise');
});

test('micro iPhone : session morte en moins de 2,5 s sans parole = micro bloqué, pas une pause', () => {
  const t = setup(); t.click('btn-mic-live');
  const s = t.sessions[0]; s.onstart(); s.onend();
  assert.equal(t.timers.size, 1, 'la réparation relance le micro');
  const [id, fn] = [...t.timers.entries()][0]; t.timers.delete(id); fn();
  assert.equal(t.sessions.length, 2);
  assert.equal(vm.runInContext('micSilentDeaths', t.c), 1);
});

test('micro iPhone : une vraie pause de 5 s reste une simple relance, jamais une réparation', () => {
  const t = setup(); t.click('btn-mic-live');
  const s = t.sessions[0]; s.onstart();
  // Simule une session qui a vécu 6 s : iOS abandonne seul sur un vrai silence.
  vm.runInContext('Date.now = (() => { const real = Date.now; return () => real() + 6000; })()', t.c);
  s.onend();
  assert.equal(vm.runInContext('micSilentDeaths', t.c), 0);
  assert.equal(vm.runInContext('emptyMicSessions', t.c), 1);
  assert.equal(t.$('btn-mic-live').classList.contains('live'), true);
});

test('après recharge micro : la leçon du profil est rouverte automatiquement', () => {
  const opened = [];
  const store = new Map([['lumi-mic-repair', JSON.stringify({ id: 'manon', at: Date.now() })]]);
  const c = vm.createContext({
    sessionStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    loadProfiles: () => [{ id: 'manon', name: 'Manon' }],
    toast(text) { c.toasted = text; },
    startChat(profile) { opened.push(profile.id); }
  });
  vm.runInContext(section('function resumeAfterMicRepair()', 'async function initApp()'), c);
  c.resumeAfterMicRepair();
  assert.deepEqual(opened, ['manon']);
  assert.match(c.toasted, /🎙️/);
  assert.equal(store.has('lumi-mic-repair'), false, 'drapeau consommé une seule fois');
  // Profil inconnu ou drapeau périmé : on ne rouvre rien de force.
  store.set('lumi-mic-repair', JSON.stringify({ id: 'inconnu', at: Date.now() }));
  c.resumeAfterMicRepair();
  assert.deepEqual(opened, ['manon']);
  store.set('lumi-mic-repair', JSON.stringify({ id: 'manon', at: Date.now() - 600000 }));
  c.resumeAfterMicRepair();
  assert.deepEqual(opened, ['manon']);
});

test('iPhone réglé sur le clavier : 🎤 ouvre le clavier au lieu du micro Safari', () => {
  const t = setup(false, false, false, { lumidictkeyboard: '1' });
  assert.equal(vm.runInContext('keyboardDictation', t.c), true);
  t.click('btn-mic');
  assert.equal(t.sessions.length, 0, 'aucun micro Safari lancé');
  assert.match(t.c.status, /clavier/i);
});
test('iPhone mode clavier : éteint la discussion puis ouvre le clavier', () => {
  const t = setup(false, false, false, { lumidictkeyboard: '1' });
  t.click('btn-mic-live');
  assert.equal(t.sessions.length, 1);
  t.click('btn-mic');
  assert.ok(t.sessions[0].aborted, 'la discussion est arrêtée');
  assert.match(t.c.status, /clavier/i);
  assert.equal(t.sessions.length, 1, 'pas de nouveau micro Safari');
});
