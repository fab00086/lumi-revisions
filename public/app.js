'use strict';

// ---------- Raccourcis ----------
const $ = (id) => document.getElementById(id);
let currentProfile = null;
let chatGeneration = 0;
let activeChat = null;
let chatLoading = false;
let archiving = false;
function cancelChat() {
  stopListening();
  stopSpeech();
  lastSpeechText = '';
  chatGeneration++;
  if (activeChat) activeChat.abort();
  activeChat = null;
  chatLoading = false;
  removeTyping();
}
let history = []; // { role, content }

// ---------- Utilitaires ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function renderMarkdown(text) {
  let t = escapeHtml(text);
  // Maths LaTeX (KaTeX) : $$...$$ en bloc, $...$ en ligne
  if (window.katex) {
    t = t.replace(/\$\$([^$]+)\$\$/g, (m, x) => { try { return katex.renderToString(x, { displayMode: true, throwOnError: false }); } catch { return m; } });
    t = t.replace(/\$([^$\n]+?)\$/g, (m, x) => { try { return katex.renderToString(x, { displayMode: false, throwOnError: false }); } catch { return m; } });
  }
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*(.+?)\*/g, '<em>$1</em>');
  t = t.replace(/^- (.*)$/gm, '• $1');
  t = t.replace(/\n/g, '<br>');
  return t;
}

// Nettoie un texte pour la lecture vocale (retire emojis et symboles)
function cleanForSpeech(text) {
  let t = String(text || '');
  try { t = t.replace(/\p{Extended_Pictographic}/gu, ''); } catch (e) {}
  // LaTeX : garde le contenu, jette les commandes (\frac{3}{4} -> 3 sur 4)
  t = t.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '$1 sur $2');
  t = t.replace(/\\sqrt\{([^{}]+)\}/g, 'racine de $1');
  t = t.replace(/\\[a-zA-Z]+/g, ' ');
  t = t.replace(/[${}\\]/g, ' ');
  t = t.replace(/[️‍\u{1F3FB}-\u{1F3FF}]/gu, '');
  t = t.replace(/\*\*(.+?)\*\*/g, '$1');
  t = t.replace(/\*([^*\n]+)\*/g, '$1');
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/^\s*[-•▪◦·]\s*/gm, '');
  t = t.replace(/[«»“”‘’]/g, '');
  t = t.replace(/\s*\n+\s*/g, '. ');
  t = t.replace(/[ \t]{2,}/g, ' ');
  return t.trim();
}

// ---------- Profils ----------
function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// Profils partages entre tous les appareils via le serveur
let profilesCache = [];
const pendingLessons = new Map();

async function fetchProfiles() {
  try {
    const r = await fetch('/api/profiles');
    if (!r.ok) throw new Error('Chargement des profils impossible');
    let list = await r.json();
    if (!Array.isArray(list) || !list.length) {
      // migration depuis l'ancien stockage local du navigateur
      try { list = JSON.parse(localStorage.getItem('lumiprofiles') || '[]'); } catch { list = []; }
      if (list.length) await saveProfiles(list);
    }
    profilesCache = (Array.isArray(list) ? list : []).map(p => { if (!p.id) p.id = generateId(); return p; });
  } catch {}
}

function loadProfiles() { return profilesCache; }
async function saveProfiles(list) {
  const r = await fetch('/api/profiles', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profiles: list })
  });
  if (!r.ok) throw new Error('Sauvegarde des profils impossible. Réessaie.');
  profilesCache = list;
}

function renderProfiles() {
  const box = $('profiles');
  const list = loadProfiles();
  box.innerHTML = '';
  list.forEach((p, i) => {
    const el = document.createElement('button');
    el.className = 'profile-pill';
    el.innerHTML = `${p.photo ? `<img src="${escapeHtml(p.photo)}" class="pill-photo" alt="">` : ''} ${escapeHtml(p.name)} <span class="badge">${escapeHtml(p.age)} ans</span> <span class="del" data-i="${i}">✕</span>`;
    el.addEventListener('click', async (e) => {
      if (e.target.classList.contains('del')) {
        e.stopPropagation();
        try { await saveProfiles(list.filter((_, index) => index !== i)); renderProfiles(); }
        catch (err) { alert(err.message); }
        return;
      }
      startChat(p);
    });
    box.appendChild(el);
  });
}

// Photo de profil (selfie)
let pendingPhoto = null; // dataURL jpeg

$('profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('pf-name').value.trim();
  const age = parseInt($('pf-age').value, 10);
  if (!name || !age) return;
  const photo = pendingPhoto;
  const list = loadProfiles();
  const child = { id: generateId(), name, age, photo: photo || null };
  try { await saveProfiles([...list, child]); }
  catch (err) { alert(err.message); return; }
  pendingPhoto = null;
  $('pf-photo-preview').classList.add('hidden');
  $('pf-photo-preview').removeAttribute('src');
  $('pf-photo-btn').textContent = '📷 Photo (selfie)';
  $('pf-name').value = ''; $('pf-age').value = '';
  renderProfiles();
  startChat(child);
});

// ---------- Chat ----------
async function startChat(p) {
  if (archiving) return;
  cancelChat();
  const generation = chatGeneration;
  chatLoading = true;
  currentProfile = p;
  history = [];
  $('screen-profile').classList.add('hidden');
  $('screen-chat').classList.remove('hidden');
  $('child-name').textContent = p.name;
  $('child-age').textContent = p.age + ' ans';
  const ph = $('child-photo');
  if (p.photo) { ph.src = p.photo; ph.classList.remove('hidden'); } else { ph.classList.add('hidden'); }
  $('chat').innerHTML = '';

  // Recharge la lecon en cours de l'enfant (pour reprendre)
  let saved = null;
  if (p.id) {
    try {
      const r = await fetch('/api/child?id=' + encodeURIComponent(p.id));
      if (!r.ok) throw new Error('Chargement impossible');
      saved = await r.json();
    } catch {
      if (generation === chatGeneration) {
        addBubble('assistant', '⚠️ Impossible de charger la leçon. Reviens aux profils puis réessaie.');
      }
      return;
    }
  }

  if (generation !== chatGeneration) return;
  chatLoading = false;
  if (pendingLessons.has(p.id)) saved = { history: pendingLessons.get(p.id) };
  if (saved && Array.isArray(saved.history) && saved.history.length) {
    history = saved.history;
    for (const h of history) {
      if (h.role === 'user') addBubble('user', escapeHtml(h.content || ''));
      else addBubble('assistant', renderMarkdown(h.content || ''));
    }
    addBubble('assistant', "👋 De retour ! On reprend ta leçon où on s'était arrêté. Pose-moi ta prochaine question 😊");
    speak("De retour ! On reprend ta leçon où on s'était arrêté. Pose-moi ta prochaine question.");
  } else {
    const greeting = `Salut ${escapeHtml(p.name)} ! 👋 Je suis Lumi. Montre-moi ton devoir (photo 📷) ou pose-moi une question. Je vais t'aider à trouver la réponse toi-même, promis !`;
    addBubble('assistant', greeting);
    speak(`Salut ${p.name} ! Je suis Lumi, ton maître ou ta maîtresse. Montre-moi ton devoir, ou pose-moi une question, et je t'aiderai à trouver la réponse toi-même.`);
  }
}

// Sauvegarde la lecon en cours sur le serveur
async function saveChild(profile = currentProfile, messages = history) {
  if (!profile || !profile.id) return;
  pendingLessons.set(profile.id, messages);
  const r = await fetch('/api/child', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: profile.id, name: profile.name, age: profile.age, history: messages })
  });
  if (!r.ok) throw new Error('La leçon n’a pas été sauvegardée. Réessaie avant de quitter.');
  pendingLessons.delete(profile.id);
}

function addBubble(role, html, sources) {
  const chat = $('chat');
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (role === 'user' ? 'user' : 'assistant');
  const b = document.createElement('div');
  b.className = 'bubble';
  b.innerHTML = html;
  wrap.appendChild(b);
  if (sources && sources.length) {
    const s = document.createElement('div');
    s.className = 'sources';
    s.innerHTML = '<strong>📚 Sources :</strong> ' + sources.map(x => `<a href="${escapeHtml(x.url)}" target="_blank" rel="noopener">${escapeHtml(x.title)}</a>`).join(' · ');
    wrap.appendChild(s);
  }
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  return b;
}

function addTyping() {
  const chat = $('chat');
  const w = document.createElement('div');
  w.className = 'msg assistant';
  w.id = 'typing';
  w.innerHTML = '<div class="bubble typing"><span></span><span></span><span></span></div>';
  chat.appendChild(w);
  chat.scrollTop = chat.scrollHeight;
}
function removeTyping() { const t = $('typing'); if (t) t.remove(); }

async function send(text, imageBase64) {
  const clean = (text || '').trim();
  if ((!clean && !imageBase64) || !currentProfile || activeChat || chatLoading || archiving) return;
  const generation = chatGeneration;
  const profile = { ...currentProfile };
  const messages = history;
  const controller = new AbortController();
  activeChat = controller;
  const timeout = setTimeout(() => controller.abort(), 120000);
  stopSpeech(); // l'enfant "coupe la parole" en envoyant un nouveau message

  if (imageBase64) {
    const chat = $('chat');
    const w = document.createElement('div');
    w.className = 'msg user';
    const d = document.createElement('div');
    d.className = 'bubble-img';
    d.innerHTML = `<img src="data:image/jpeg;base64,${imageBase64}" alt="photo du cahier">`;
    w.appendChild(d);
    chat.appendChild(w);
    chat.scrollTop = chat.scrollHeight;
  } else {
    addBubble('user', escapeHtml(clean));
  }

  $('input').value = '';
  addTyping();
  setStatus('Je réfléchis… 🤔');

  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ message: clean, image: imageBase64 || null, profile, history: messages })
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || ('HTTP ' + r.status));
    }
    if (generation !== chatGeneration) return;
    // Lecture du flux : {type: status|start|delta|error|done}
    const bubble = addBubble('assistant', '');
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '', sources = [], hadError = null, firstDelta = true;
    while (true) {
      const { done, value } = await reader.read();
      if (generation !== chatGeneration) return;
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'status') {
          setStatus(ev.text);
        } else if (ev.type === 'delta') {
          if (firstDelta) { firstDelta = false; removeTyping(); setStatus("Je t'écoute 👂"); }
          full += ev.text;
          bubble.innerHTML = renderMarkdown(full);
          const chat = $('chat'); chat.scrollTop = chat.scrollHeight;
        } else if (ev.type === 'error') {
          hadError = ev.error;
        } else if (ev.type === 'done') {
          sources = ev.sources || [];
        }
      }
    }
    removeTyping();
    setStatus("Je t'écoute 👂");

    if (hadError && !full) { bubble.closest('.msg').remove(); addBubble('assistant', '⚠️ ' + escapeHtml(hadError)); return; }
    if (!full) { bubble.closest('.msg').remove(); addBubble('assistant', '⚠️ Réponse vide — réessaie.'); return; }

    bubble.innerHTML = renderMarkdown(full);
    if (sources && sources.length) {
      const s = document.createElement('div');
      s.className = 'sources';
      s.innerHTML = '<strong>📚 Sources :</strong> ' + sources.map(x => `<a href="${escapeHtml(x.url)}" target="_blank" rel="noopener">${escapeHtml(x.title)}</a>`).join(' · ');
      bubble.parentElement.appendChild(s);
    }
    messages.push({ role: 'user', content: clean || '[photo du cahier]' });
    messages.push({ role: 'assistant', content: full });
    try {
      await saveChild(profile, messages);
    } catch (err) {
      if (generation === chatGeneration) addBubble('assistant', '⚠️ ' + escapeHtml(err.message));
    }
    if (generation === chatGeneration) speak(full);
  } catch (err) {
    if (generation !== chatGeneration) return;
    removeTyping();
    setStatus("Je t'écoute 👂");
    addBubble('assistant', '⚠️ Impossible de joindre Lumi : ' + escapeHtml(String(err)));
  } finally {
    clearTimeout(timeout);
    if (activeChat === controller) activeChat = null;
  }
}

function setStatus(txt) { $('teacher-status').textContent = txt; }

// ---------- Voix (lecture + avatar qui parle) ----------
let voicePref = localStorage.getItem('lumivoice') || null;
let voiceRate = parseFloat(localStorage.getItem('lumirate') || '1.0');

function frenchVoices() {
  if (!('speechSynthesis' in window)) return [];
  return (speechSynthesis.getVoices() || []).filter(v => v.lang && v.lang.toLowerCase().startsWith('fr'));
}

// Choisit la meilleure voix : les voix "naturelles" d'abord
function pickBestVoice() {
  const fr = frenchVoices();
  if (!fr.length) return null;
  if (voicePref) { const chosen = fr.find(v => v.name === voicePref); if (chosen) return chosen; }
  const score = (v) => {
    let s = 0;
    const n = v.name.toLowerCase();
    if (n.includes('natural')) s += 5;
    if (n.includes('neural')) s += 5;
    if (n.includes('online')) s += 3;
    if (n.includes('google')) s += 2;
    if (n.includes('premium') || n.includes('enhanced')) s += 2;
    if (v.lang === 'fr-FR') s += 1;
    return s;
  };
  fr.sort((a, b) => score(b) - score(a));
  return fr[0];
}

function populateVoiceSelect() {
  const sel = $('voice-select');
  const fr = frenchVoices();
  const best = pickBestVoice();
  sel.innerHTML = '';
  if (!fr.length) {
    sel.innerHTML = '<option value="">Aucune voix française trouvée</option>';
    return;
  }
  fr.forEach(v => {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = `${v.name}${v.lang === 'fr-FR' ? '' : ' (' + v.lang + ')'}${(!voicePref && v === best) ? ' ✨' : ''}`;
    if (voicePref ? v.name === voicePref : v === best) o.selected = true;
    sel.appendChild(o);
  });
}

$('voice-select').addEventListener('change', (e) => {
  voicePref = e.target.value;
  localStorage.setItem('lumivoice', voicePref);
  speak('Bonjour ! Voici ma nouvelle voix.');
});

$('rate-slider').addEventListener('input', (e) => {
  voiceRate = parseFloat(e.target.value);
  $('rate-val').textContent = voiceRate.toFixed(2);
  localStorage.setItem('lumirate', String(voiceRate));
});

if ('speechSynthesis' in window) {
  speechSynthesis.onvoiceschanged = () => populateVoiceSelect();
  populateVoiceSelect();
  $('rate-slider').value = String(voiceRate);
  $('rate-val').textContent = voiceRate.toFixed(2);
}

// Un vrai bouton déclenche la lecture dans le geste utilisateur Safari.
// Un énoncé vide et muet ne prouve pas que la lecture a été autorisée.
let lastSpeechText = '';
let speechTimer = null;
let speechUtterances = [];
$('btn-listen').addEventListener('click', () => speak(lastSpeechText || 'Bonjour ! Je suis Lumi.'));
$('btn-test-voice').addEventListener('click', () => speak('Bonjour ! Je suis Lumi. Est-ce que tu entends ma voix ?'));

// Decoupe le texte aux fins de phrases : iOS coupe le son sur les
// textes longs, il faut plusieurs morceaux courts.
function splitForSpeech(text, maxLen = 160) {
  const out = [];
  let cur = '';
  const push = () => { const t = cur.trim(); if (t) out.push(t); cur = ''; };
  for (const w of String(text).split(/\s+/)) {
    cur += (cur ? ' ' : '') + w;
    if (cur.length >= maxLen || /[.!?]$/.test(cur)) push();
  }
  push();
  return out.length ? out : [text];
}

let speakGen = 0;

// Coupe la parole en cours (bouton ✋, micro, ou envoi d'un message)
function stopSpeech() {
  speakGen++; // invalide les fins d'ecoute des morceaux en cours
  clearTimeout(speechTimer);
  speechUtterances = [];
  try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch {}
  $('avatar').classList.remove('talking');
  $('btn-stop').classList.add('hidden');
  setStatus("Je t'écoute 👂");
}

// Appuie sur l'avatar = couper la parole aussi
// (et en mode discussion, le micro reprend tout de suite après)
$('avatar').addEventListener('click', () => { stopSpeech(); if (typeof micLiveResume === 'function') micLiveResume(); });
$('btn-stop').addEventListener('click', () => { stopSpeech(); if (typeof micLiveResume === 'function') micLiveResume(); });

function speak(text) {
  lastSpeechText = cleanForSpeech(text);
  if (!('speechSynthesis' in window)) {
    setStatus('La lecture vocale est indisponible dans ce navigateur.');
    if (typeof micLiveResume === 'function') micLiveResume();
    return;
  }
  try {
    text = lastSpeechText;
    if (!text) return;
    stopListening();
    stopSpeech();
    const gen = ++speakGen; // annule les fins d'ecoute des anciens morceaux
    const voice = pickBestVoice();
    const start = () => {
      if (gen !== speakGen) return;
      const parts = splitForSpeech(text);
      let pending = parts.length;
      const done = () => {
        if (gen !== speakGen) return;
        if (--pending <= 0) {
          clearTimeout(speechTimer);
          speechUtterances = [];
          $('avatar').classList.remove('talking');
          $('btn-stop').classList.add('hidden');
          setStatus("Je t'écoute 👂");
          // Mode discussion : le micro se rouvre maintenant que Lumi s'est tu.
          if (typeof micLiveResume === 'function') micLiveResume();
        }
      };
      for (const part of parts) {
        const u = new SpeechSynthesisUtterance(part);
        u.lang = 'fr-FR';
        u.rate = voiceRate || 1;
        if (voice) u.voice = voice;
        speechUtterances.push(u); // conserve les énoncés jusqu'à leur fin
        u.onstart = () => {
          if (gen === speakGen) {
            clearTimeout(speechTimer);
            $('avatar').classList.add('talking');
            $('btn-stop').classList.remove('hidden');
            setStatus('Je parle 🗣️ (appuie sur ✋ pour me couper)');
          }
        };
        u.onend = done;
        u.onerror = () => {
          if (gen !== speakGen) return;
          stopSpeech();
          setStatus('Appuie sur 🔊 Écouter Lumi pour lancer la voix.');
          if (typeof micLiveResume === 'function') micLiveResume();
        };
        speechSynthesis.speak(u);
      }
    };
    setStatus('Préparation de la voix…');
    speechTimer = setTimeout(() => {
      if (gen !== speakGen) return;
      stopSpeech();
      setStatus('Appuie sur 🔊 Écouter Lumi pour lancer la voix.');
      if (typeof micLiveResume === 'function') micLiveResume();
    }, 5000);
    // Aucun délai : un clic doit conserver son activation utilisateur.
    start();
  } catch {
    stopSpeech();
    setStatus('Appuie sur 🔊 Écouter Lumi pour réessayer la voix.');
    if (typeof micLiveResume === 'function') micLiveResume();
  }
}

// iOS : Safari refuse de lire un texte lance automatiquement (apres une
// reponse de Lumi) tant qu'un premier enonce n'a pas ete lance DANS un geste
// utilisateur. On "deverrouille" donc la voix au premier toucher : un enonce
// muet, inaudible, qui autorise ensuite toutes les lectures automatiques.
let voiceUnlocked = false;
function unlockVoice() {
  if (voiceUnlocked || !('speechSynthesis' in window)) return;
  voiceUnlocked = true;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  } catch {}
}
document.addEventListener('touchend', unlockVoice, { once: true, passive: true });
document.addEventListener('click', unlockVoice, { once: true, passive: true });

// ---------- Caméra (webcam + galerie) ----------
let cameraStream = null;
let cameraCallback = null;
let cameraFileTarget = null;

function stopCamera() {
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  const v = $('camera-video');
  if (v) v.srcObject = null;
  $('camera-modal').classList.add('hidden');
  $('camera-msg').classList.add('hidden');
}

function finishCamera(base64) {
  stopCamera();
  const cb = cameraCallback;
  cameraCallback = null;
  if (cb && base64) cb(base64);
}

async function openCamera(callback, facingMode, fileTarget) {
  cameraCallback = callback;
  cameraFileTarget = fileTarget || $('mic');
  // iPhone/iPad : ouvrir l'appareil photo NATIF tout de suite.
  // La camera de Safari est bloquee tant que le certificat n'est pas
  // approuve ; l'app native, elle, marche toujours, sans permission.
  if (isIOS && cameraFileTarget) { cameraFileTarget.click(); return; }
  $('camera-msg').classList.add('hidden');
  $('camera-modal').classList.remove('hidden');
  const v = $('camera-video');
  $('btn-camera-capture').classList.remove('hidden');
  v.classList.remove('hidden');
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facingMode || 'environment' }, audio: false });
      v.srcObject = cameraStream;
    } else {
      throw new Error('no camera');
    }
  } catch (e) {
    v.classList.add('hidden');
    $('btn-camera-capture').classList.add('hidden');
    $('camera-msg').classList.remove('hidden');
    $('camera-msg').textContent = 'Caméra indisponible ici — clique « Choisir une image » (sur téléphone, ça ouvre l’appareil photo).';
  }
}

$('btn-camera-capture').addEventListener('click', () => {
  const v = $('camera-video');
  if (!v.srcObject) return;
  const c = document.createElement('canvas');
  c.width = v.videoWidth || 640;
  c.height = v.videoHeight || 480;
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  finishCamera(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
});

$('btn-camera-close').addEventListener('click', stopCamera);

$('btn-camera-gallery').addEventListener('click', () => {
  stopCamera();
  if (cameraFileTarget) cameraFileTarget.click();
});

// Bouton 📷 du cahier
$('btn-camera').addEventListener('click', () => openCamera(b64 => send('', b64), 'environment', $('mic')));

// Galerie / téléphone (cahier)
$('mic').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  compressImage(f, 1200, 0.85).then(b64 => finishCamera(b64));
  e.target.value = '';
});

// Photo de profil (selfie) via la caméra aussi
function setProfilePhoto(base64) {
  pendingPhoto = 'data:image/jpeg;base64,' + base64;
  const img = $('pf-photo-preview');
  img.src = pendingPhoto;
  img.classList.remove('hidden');
  $('pf-photo-btn').textContent = '📷 Changer la photo';
}

$('pf-photo-btn').addEventListener('click', () => openCamera(setProfilePhoto, 'user', $('pf-photo-file')));

$('pf-photo-file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  compressImage(f, 300, 0.8).then(b64 => setProfilePhoto(b64));
  e.target.value = '';
});

function compressImage(file, maxDim, quality) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', quality).split(',')[1]);
      };
      img.onerror = () => resolve(null);
      img.src = reader.result;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

// ---------- Micro (voix) ----------
let recog = null;
let micTimer = null;
// Mode discussion ("mains libres", comme ChatGPT voix) : le micro reste
// ouvert pendant TOUTE la conversation — il se rouvre tout seul quand Lumi
// a fini de parler (ou quand iOS coupe la session), jusqu'a ce qu'on
// rappuie sur le bouton 🎙️. Un appui sur 🎤 coupe aussi le mode.
let liveMic = false;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
function stopListening() {
  clearTimeout(micTimer);
  const previous = recog;
  recog = null; // ignore les événements tardifs (profil changé, voix démarrée)
  $('btn-mic').classList.remove('recording');
  if (previous) { try { previous.abort(); } catch {} }
}
function micError(error) {
  if (liveMic) { liveMic = false; $('btn-mic-live').classList.remove('live'); }
  setStatus('Micro indisponible — tu peux utiliser la dictée du clavier.');
  const help = isIOS
    ? "Sur iPhone : ouvre Lumi via le QR code ou l'adresse 🌍 trycloudflare.com (pas l'adresse https://192.168…), autorise le micro dans les réglages du site, et vérifie que Siri ET la Dictée (Réglages → Général → Clavier) sont activés."
    : "Autorise le microphone dans les réglages du site de ton navigateur.";
  const messages = {
    'not-allowed': help,
    'service-not-allowed': help,
    'audio-capture': 'Vérifie que le microphone est disponible et autorisé, puis réessaie.',
    'no-speech': "Je n'ai rien entendu. Appuie sur le micro et parle près du téléphone.",
    'network': 'La reconnaissance vocale ne répond pas. Vérifie ta connexion et réessaie.',
    'timeout': "La reconnaissance vocale n'a pas répondu. Recharge la page ou utilise la dictée du clavier.",
  };
  addBubble('assistant', '🎤 ' + (messages[error] || 'Le micro est indisponible. Tu peux écrire ta question ou utiliser la dictée du clavier.'));
}
function setLiveMic(on) {
  liveMic = on;
  if (on) $('btn-mic-live').classList.add('live');
  else { $('btn-mic-live').classList.remove('live'); stopListening(); }
}
// Rouvre le micro du mode discussion (apres un delai court) si rien ne tourne.
function micLiveRestart(delay = 300) {
  clearTimeout(micTimer);
  micTimer = setTimeout(() => {
    if (liveMic && !recog && !chatLoading && !activeChat && !archiving) startListening();
  }, delay);
}
// Appele par la voix quand Lumi a fini (ou echoue) de parler : le micro
// reprend tout seul en mode discussion. typeof : la section voix peut etre
// chargee avant celle-ci.
function micLiveResume() {
  if (liveMic) micLiveRestart(350);
}
function startListening() {
  if (recog || chatLoading || activeChat || archiving) return;
  if (!window.isSecureContext) {
    setLiveMic(false);
    addBubble('assistant', '🎤 Ouvre Lumi avec son adresse HTTPS sécurisée : https://lumi-revisions.onrender.com/');
    return;
  }
  if (!SR) {
    micError('service-not-allowed');
    return;
  }
  try {
    // Nouvelle instance à chaque essai : évite de réutiliser une session bloquée.
    const session = new SR();
    recog = session;
    const generation = chatGeneration;
    session.lang = 'fr-FR';
    session.continuous = false;
    session.interimResults = false;
    session.onstart = () => {
      if (recog === session) setStatus(liveMic ? 'Mode discussion 🎙️ — parle, je t’écoute !' : "Je t'écoute… 🎤");
    };
    session.onresult = (e) => {
      if (recog !== session || generation !== chatGeneration) return;
      const text = e.results[0][0].transcript;
      stopListening();
      $('input').value = text;
      send(text);
    };
    session.onerror = (e) => {
      if (recog !== session) return;
      stopListening();
      if (e.error !== 'aborted') micError(e.error);
    };
    session.onend = () => {
      if (recog !== session) return;
      stopListening();
      if (liveMic) { micLiveRestart(); return; } // iOS coupe souvent : on rouvre
      setStatus("Je t'écoute 👂");
    };
    $('btn-mic').classList.add('recording');
    setStatus(liveMic ? 'Mode discussion 🎙️ — parle, je t’écoute !' : 'Autorise le micro si Safari le demande, puis parle.');
    micTimer = setTimeout(() => {
      if (recog !== session) return;
      stopListening();
      if (liveMic) { micLiveRestart(); return; } // silence prolongé : on réécoute
      micError('timeout');
    }, 30000);
    // Safari gère lui-même ses permissions. Ne pas attendre getUserMedia
    // avant start() : cela peut perdre le geste et monopoliser le micro.
    session.start();
  } catch {
    stopListening();
    micError('service-not-allowed');
  }
}
$('btn-mic-live').addEventListener('click', () => {
  if (liveMic) { setLiveMic(false); setStatus('Mode discussion éteint. Appuie sur 🎤 quand tu veux parler.'); return; }
  setLiveMic(true);
  stopSpeech();
  setStatus('Mode discussion 🎙️ — parle, je t’écoute tout le temps !');
  startListening();
});
$('btn-mic').addEventListener('click', () => {
  if (recog) { stopListening(); setStatus("Je t'écoute 👂"); return; }
  if (liveMic) { setLiveMic(false); setStatus('Mode discussion éteint. Appuie sur 🎤 quand tu veux parler.'); return; }
  stopSpeech();
  if (chatLoading || activeChat || archiving) {
    setStatus('Attends la fin du chargement ou de la réponse, puis appuie sur 🎤.');
    return;
  }
  startListening();
});

// ---------- Envoi ----------
$('btn-send').addEventListener('click', () => send($('input').value));
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') send($('input').value); });

// ---------- Retour ----------
$('btn-back').addEventListener('click', () => {
  if (archiving) return;
  if (typeof setLiveMic === 'function') setLiveMic(false); // on quitte la conversation
  cancelChat();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  $('avatar').classList.remove('talking');
  $('screen-chat').classList.add('hidden');
  $('screen-profile').classList.remove('hidden');
  renderProfiles();
});

// ---------- Impression ----------
$('btn-print').addEventListener('click', () => {
  const name = currentProfile ? currentProfile.name : 'enfant';
  const msgs = [...document.querySelectorAll('#chat .msg')].map(m => m.innerText).join('\n\n');
  const w = window.open('', '_blank');
  if (!w) { alert('Autorise les fenêtres pop-up pour imprimer.'); return; }
  w.document.write(`<html><head><meta charset="utf-8"><title>Devoir — ${escapeHtml(name)}</title></head><body style="font-family:Georgia,serif;max-width:680px;margin:40px auto;padding:0 20px;color:#222"><h1>Session Lumi — ${escapeHtml(name)}</h1><hr><pre style="white-space:pre-wrap;font-family:inherit;font-size:15px;line-height:1.6">${msgs}</pre></body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
});

// ---------- Vidéos (lecteur intégré) ----------
function lastTopic() {
  const lastUser = [...history].reverse().find(h => h.role === 'user');
  return lastUser ? lastUser.content : '';
}

async function searchVideos(q) {
  const box = $('video-results');
  box.innerHTML = '<p class="hint">Recherche en cours… ⏳</p>';
  try {
    const r = await fetch('/api/videos?q=' + encodeURIComponent(q));
    const j = await r.json();
    renderVideoList(j.videos || []);
  } catch {
    box.innerHTML = '<p class="hint">⚠️ Impossible de chercher les vidéos.</p>';
  }
}

function renderVideoList(videos) {
  const box = $('video-results');
  box.innerHTML = '';
  if (!videos.length) {
    box.innerHTML = '<p class="hint">Aucune vidéo trouvée. Essaie une autre recherche.</p>';
    return;
  }
  videos.forEach(v => {
    const el = document.createElement('button');
    el.className = 'video-item';
    el.innerHTML = `<img src="${escapeHtml(v.thumbnail)}" alt=""><span>${escapeHtml(v.title)}</span>`;
    el.addEventListener('click', () => playVideo(v.id));
    box.appendChild(el);
  });
}

function playVideo(id) {
  $('video-player').innerHTML = `<iframe src="https://www.youtube.com/embed/${id}?autoplay=1" frameborder="0" allow="accelerometer; autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
  $('video-player').classList.remove('hidden');
}

$('btn-video').addEventListener('click', () => {
  $('video-modal').classList.remove('hidden');
  const q = lastTopic();
  $('video-q').value = q;
  if (q) searchVideos(q);
});
$('btn-video-search').addEventListener('click', () => {
  const q = $('video-q').value.trim();
  if (q) searchVideos(q);
});
$('video-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const q = $('video-q').value.trim(); if (q) searchVideos(q); }
});
$('btn-video-close').addEventListener('click', () => {
  $('video-modal').classList.add('hidden');
  $('video-player').innerHTML = '';
  $('video-player').classList.add('hidden');
});

// ---------- Réglages (fenêtre) ----------
$('btn-settings').addEventListener('click', () => $('settings-modal').classList.remove('hidden'));
$('btn-settings-close').addEventListener('click', () => $('settings-modal').classList.add('hidden'));

// ---------- Interro (quiz) ----------
let quizGeneration = 0, quizBusy = false;
let quizData = null, quizIdx = 0, quizScore = 0, quizTopicUsed = '';

$('btn-quiz').addEventListener('click', () => {
  $('quiz-topic-row').classList.remove('hidden');
  $('quiz-modal').classList.remove('hidden');
  $('quiz-area').innerHTML = '<p class="hint">Choisis un sujet et Lumi te pose 5 questions ! 🌟</p>';
  $('quiz-progress').textContent = '';
  if (lastTopic()) $('quiz-topic').value = lastTopic();
});
$('btn-quiz-close').addEventListener('click', () => {
  quizGeneration++;
  quizBusy = false;
  $('quiz-modal').classList.add('hidden');
  stopSpeech();
});

async function startQuiz() {
  if (quizBusy) return;
  const topic = $('quiz-topic').value.trim();
  if (!topic || !currentProfile) { $('quiz-area').innerHTML = '<p class="hint">Écris un sujet d\'abord 🙂</p>'; return; }
  quizBusy = true;
  const generation = ++quizGeneration;
  quizTopicUsed = topic;
  $('quiz-topic-row').classList.add('hidden');
  $('quiz-area').innerHTML = '<p class="hint">Je prépare ton interro… ⏳</p>';
  $('quiz-progress').textContent = '';
  try {
    const r = await fetch('/api/quiz', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, profile: currentProfile, count: 5 })
    });
    const j = await r.json();
    if (generation !== quizGeneration) return;
    if (!j.quiz || !j.quiz.length) {
      $('quiz-area').innerHTML = '<p class="hint">⚠️ Je n\'ai pas réussi à préparer les questions. Essaie encore !</p>';
      $('quiz-topic-row').classList.remove('hidden');
      return;
    }
    quizData = j.quiz; quizIdx = 0; quizScore = 0;
    renderQuizQuestion();
  } catch {
    if (generation !== quizGeneration) return;
    $('quiz-area').innerHTML = '<p class="hint">⚠️ Impossible de préparer l\'interro.</p>';
    $('quiz-topic-row').classList.remove('hidden');
  } finally {
    if (generation === quizGeneration) quizBusy = false;
  }
}
$('btn-quiz-start').addEventListener('click', startQuiz);
$('quiz-topic').addEventListener('keydown', (e) => { if (e.key === 'Enter') startQuiz(); });

function renderQuizQuestion() {
  const area = $('quiz-area');
  const q = quizData[quizIdx];
  $('quiz-progress').textContent = `Question ${quizIdx + 1} / ${quizData.length} · Score : ${quizScore} ✨`;
  area.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'quiz-card';
  card.innerHTML = `<div class="quiz-question">${renderMarkdown(q.question)}</div>`;
  q.options.forEach((opt, i) => {
    const b = document.createElement('button');
    b.className = 'quiz-option';
    b.innerHTML = renderMarkdown(opt);
    b.addEventListener('click', () => answerQuiz(i, card));
    card.appendChild(b);
  });
  const speaker = document.createElement('button');
  speaker.className = 'btn';
  speaker.textContent = '🔊 Lire la question';
  speaker.addEventListener('click', () => speak(q.question));
  card.appendChild(speaker);
  area.appendChild(card);
}

function answerQuiz(i, card) {
  const q = quizData[quizIdx];
  const good = i === q.answer;
  if (good) quizScore++;
  card.querySelectorAll('.quiz-option').forEach((b, k) => {
    b.disabled = true;
    if (k === q.answer) b.classList.add('good');
    else if (k === i) b.classList.add('bad');
  });
  const fb = document.createElement('div');
  fb.className = 'quiz-feedback';
  fb.innerHTML = (good ? '🎉 <strong>Bravo !</strong>' : '💡 Presque ! La bonne réponse est en vert.') +
    (q.explication ? ' ' + renderMarkdown(q.explication) : '');
  card.appendChild(fb);
  speak(good ? 'Bravo ! ' : 'Presque ! ') ;
  const next = document.createElement('button');
  next.className = 'btn btn-primary quiz-next';
  next.textContent = quizIdx + 1 < quizData.length ? 'Question suivante ➜' : 'Voir mon score 🏆';
  next.addEventListener('click', () => {
    quizIdx++;
    if (quizIdx < quizData.length) renderQuizQuestion(); else finishQuiz();
  });
  card.appendChild(next);
}

function finishQuiz() {
  const area = $('quiz-area');
  $('quiz-progress').textContent = `Score final : ${quizScore} / ${quizData.length}`;
  const stars = '⭐'.repeat(Math.max(1, Math.round((quizScore / quizData.length) * 5)));
  const n = currentProfile ? currentProfile.name : '';
  area.innerHTML = `<div class="quiz-final"><div class="quiz-stars">${stars}</div><p><strong>${quizScore} / ${quizData.length}</strong></p><p>${quizScore === quizData.length ? `Parfait ${escapeHtml(n)} ! Tu maîtrises ce sujet ! 🎉` : quizScore >= quizData.length / 2 ? 'Bien joué ! Réessaie pour faire encore mieux 💪' : 'Courage ! Révise un peu avec Lumi puis retente l\'interro 😊'}</p></div>`;
  const again = document.createElement('button');
  again.className = 'btn btn-primary';
  again.textContent = '🔄 Autre interro';
  again.addEventListener('click', () => {
    $('quiz-topic-row').classList.remove('hidden');
    $('quiz-area').innerHTML = '<p class="hint">Choisis un sujet et c\'est reparti ! 🌟</p>';
    $('quiz-progress').textContent = '';
  });
  area.appendChild(again);
  // On garde le score dans l'historique (visible dans l'espace parent et la progression)
  if (currentProfile && currentProfile.id) {
    fetch('/api/quiz-score', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: currentProfile.id, topic: quizTopicUsed, score: quizScore, total: quizData.length })
    }).catch(() => {});
  }
  speak(`Score final : ${quizScore} sur ${quizData.length} !`);
}

// ---------- Aide iPhone (certificat) ----------
$('btn-iphone-help').addEventListener('click', () => $('iphone-modal').classList.remove('hidden'));
$('btn-iphone-help2').addEventListener('click', () => $('iphone-modal').classList.remove('hidden'));
$('btn-iphone-close').addEventListener('click', () => $('iphone-modal').classList.add('hidden'));

// ---------- Diagnostic micro + voix ----------
// Fait sur l'appareil lui-meme (iPhone en particulier) : au lieu de deviner
// pourquoi le micro ou la voix ne marchent pas, on teste chaque brique et on
// affiche un rapport. Envoie une capture de ce rapport si besoin d'aide.
$('btn-diag-voice').addEventListener('click', () => {
  $('settings-modal').classList.add('hidden');
  $('diag-content').innerHTML = '<p class="hint">Appuie sur « Lancer le diagnostic » puis accepte la demande de micro si Safari la montre.</p>';
  $('diag-modal').classList.remove('hidden');
});
$('btn-diag-close').addEventListener('click', () => $('diag-modal').classList.add('hidden'));

function diagBeep() {
  return new Promise((resolve) => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 440;
      g.gain.value = 0.3;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      setTimeout(() => { try { o.stop(); ctx.close(); } catch {} resolve(true); }, 600);
    } catch { resolve(false); }
  });
}

function diagMic() {
  return new Promise((resolve) => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return resolve('API micro absente du navigateur');
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then((s) => {
        const label = (s.getAudioTracks()[0] || {}).label || 'micro';
        s.getTracks().forEach((t) => t.stop());
        resolve('ok (' + label + ')');
      })
      .catch((e) => resolve('refus ou erreur : ' + (e.name || e.message)));
  });
}

function diagSR() {
  return new Promise((resolve) => {
    const SRc = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SRc) return resolve('reconnaissance vocale absente de ce navigateur (iOS trop ancien ou navigateur limite)');
    let done = false;
    const finish = (msg) => { if (!done) { done = true; try { r.abort(); } catch {} resolve(msg); } };
    let r;
    try {
      r = new SRc();
    } catch (e) {
      return resolve('impossible a creer : ' + e.message);
    }
    r.lang = 'fr-FR';
    r.onstart = () => finish('demarre — dis un mot pour completer le test');
    r.onerror = (e) => finish('erreur : ' + e.error);
    r.onresult = () => finish('voix reconnue correctement');
    r.onend = () => finish('demarre puis s\'est arrete (tu n\'as rien dit ?)');
    try {
      r.start();
    } catch (e) {
      return finish('lancement impossible : ' + e.message);
    }
    setTimeout(() => finish('aucune reponse en 6 s'), 6000);
  });
}

function diagSpeech() {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve('synthese vocale absente de ce navigateur');
    let started = false;
    try { speechSynthesis.cancel(); } catch {}
    const u = new SpeechSynthesisUtterance('Bonjour.');
    u.lang = 'fr-FR';
    u.onstart = () => { started = true; };
    u.onend = () => resolve(started ? 'ok : la voix a parle' : 'coupee avant de parler (mode silencieux ?)');
    u.onerror = (e) => resolve('erreur : ' + (e.error || 'inconnue'));
    speechSynthesis.speak(u);
    setTimeout(() => resolve(started ? 'ok : la voix parle toujours' : 'jamais demarree'), 6000);
  });
}

$('btn-diag-run').addEventListener('click', async () => {
  const btn = $('btn-diag-run');
  btn.disabled = true;
  const rows = [];
  const report = [];
  const add = (ok, label, detail) => {
    const icon = ok === true ? '✅' : ok === false ? '❌' : '⚠️';
    const line = `${icon} <strong>${label}</strong>${detail ? ' — ' + escapeHtml(detail) : ''}`;
    rows.push(`<li class="${ok === true ? 'diag-ok' : ok === false ? 'diag-bad' : 'diag-warn'}">${line}</li>`);
    report.push(`${ok === true ? 'OK' : ok === false ? 'ECHEC' : '!'} ${label}${detail ? ' -- ' + detail : ''}`);
    $('diag-content').innerHTML = '<ol class="diag-list">' + rows.join('') + '</ol>';
  };

  const ua = navigator.userAgent;
  const iosVer = (ua.match(/OS (\d+_\d+(?:_\d+)?)/) || [])[1];
  add(null, 'Appareil', (isIOS ? 'iPhone/iPad' : 'autre appareil') + (iosVer ? ' · iOS ' + iosVer.replace(/_/g, '.') : '') + ' · ' + (window.isSecureContext ? 'HTTPS sécurisé' : 'PAS en HTTPS') + ' · ' + location.hostname);

  add(!!('speechSynthesis' in window), 'Voix de synthèse disponible', 'speechSynthesis' + ('speechSynthesis' in window ? '' : ' absent'));
  if ('speechSynthesis' in window) {
    const fr = frenchVoices();
    add(fr.length > 0, 'Voix françaises trouvées', fr.length + ' (' + fr.slice(0, 3).map((v) => v.name).join(', ') + ')');
  }

  const beep = await diagBeep();
  add(beep, 'Haut-parleur (bip de test)', beep ? 'un bip a été joué : entends-tu un son ?' : 'impossible de jouer un son');

  const mic = await diagMic();
  add(/^ok/.test(mic), 'Permission micro du site', mic);

  const sr = await diagSR();
  add(/^voix reconnue|demarre/.test(sr), 'Reconnaissance vocale (Siri/Dictée)', sr);

  const speech = await diagSpeech();
  add(/^ok/.test(speech), 'Lecture à voix haute', speech);

  rows.push('<li class="diag-warn">📋 <strong>Rapport texte</strong> (copie-le ou fais une capture d\'écran si tu demandes de l\'aide) :</li>');
  rows.push('<li><textarea class="diag-report" readonly rows="8">' + escapeHtml(report.join('\n')) + '</textarea></li>');
  $('diag-content').innerHTML = '<ol class="diag-list">' + rows.join('') + '</ol>';
  btn.disabled = false;
});

// ---------- QR code de connexion (telephone) ----------
async function loadConnectQr() {
  try {
    const r = await fetch('/api/qr');
    const j = await r.json();
    if (j.qr) {
      $('connect-qr').src = j.qr;
      $('connect-url').textContent = 'Sur le téléphone (iPhone inclus), ouvre : ' + (j.url || '');
      const t = $('connect-tunnel');
      if (t) {
        if (j.tunnel_url) {
          t.href = j.tunnel_url;
          t.textContent = '🌍 Depuis n\'importe où (PC allumé) : ' + j.tunnel_url.replace('https://', '');
          t.parentElement.classList.remove('hidden');
        } else {
          t.parentElement.classList.add('hidden');
        }
      }
    } else {
      $('connect-url').textContent = 'QR code indisponible pour le moment.';
    }
  } catch {
    $('connect-url').textContent = '⚠️ Impossible de générer le QR code.';
  }
}

$('btn-connect').addEventListener('click', () => {
  const p = $('connect-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) loadConnectQr();
});

// ---------- Progression + nouvelle lecon ----------
function topicLabelFront(historyArr) {
  const first = (historyArr || []).find(h => h.role === 'user');
  let t = String(first && first.content || '').replace(/\n/g, ' ').trim();
  if (t === '[photo du cahier]' || t.startsWith('[photo')) t = 'Devoir (photo)';
  if (t.length > 40) t = t.slice(0, 40) + '…';
  return t || 'Leçon';
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('fr-FR') + ' · ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

$('btn-new').addEventListener('click', async () => {
  if (!currentProfile || archiving || chatLoading || activeChat) return;
  archiving = true;
  const profile = { ...currentProfile };
  try {
    const r = await fetch('/api/child', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: profile.id, name: profile.name, age: profile.age, history, action: 'archive' })
    });
    if (!r.ok) throw new Error('Archivage impossible. Ta leçon est conservée, réessaie.');
    pendingLessons.delete(profile.id);
    cancelChat();
    history = [];
    $('chat').innerHTML = '';
    addBubble('assistant', 'Nouvelle leçon, ' + escapeHtml(profile.name) + ' ! 👋 Montre-moi ton devoir ou pose une question.');
    if (typeof micLiveResume === 'function') micLiveResume();
  } catch (err) {
    addBubble('assistant', '⚠️ ' + escapeHtml(err.message));
  } finally {
    archiving = false;
  }
});

async function openProgress(view) {
  const box = $('progress-content');
  $('progress-modal').classList.remove('hidden');
  if (view) { renderSession(view); return; } // vue conversation
  box.innerHTML = '<p class="hint">Chargement… ⏳</p>';
  if (!currentProfile || !currentProfile.id) {
    box.innerHTML = '<p class="hint">Aucune progression pour le moment.</p>';
    return;
  }
  let d = null;
  try { d = await (await fetch('/api/child?id=' + encodeURIComponent(currentProfile.id))).json(); } catch {}
  if (!d) { box.innerHTML = '<p class="hint">Aucune progression pour le moment.</p>'; return; }
  const orig = d.sessions || [];
  const sessions = orig.slice().reverse();
  const currentTopic = (d.history && d.history.length) ? topicLabelFront(d.history) : null;
  let html = '';
  if (currentTopic) {
    html += `<div class="prog-current">🕐 <strong>Leçon en cours :</strong> ${escapeHtml(currentTopic)}</div>`;
  }
  if (!sessions.length && !currentTopic) {
    html += '<p class="hint">Pas encore de leçon commencée. Pose une question pour démarrer !</p>';
  } else if (!sessions.length) {
    html += '<p class="hint">Pas encore de leçon terminée (appuie sur 🆕 pour finir une leçon).</p>';
  } else {
    html += '<p class="hint" style="margin:0 0 8px">Leçons terminées — appuie dessus pour relire la conversation :</p><ul class="prog-list">';
    // les sessions les plus recentes d'abord ; on garde l'index d'origine pour la vue detail

    sessions.forEach((s, k) => {
      const idx = orig.length - 1 - k;
      const flag = Array.isArray(s.a_travailler) && s.a_travailler.length ? ' 🔧' : '';
      html += `<li><button class="prog-item prog-link" data-idx="${idx}"><span class="prog-topic">${escapeHtml(s.topic)}${flag}</span><span class="prog-meta">${s.count} réponses · ${formatDate(s.date)}</span></button></li>`;
    });
    html += '</ul>';
  }
  box.innerHTML = html;
  box.querySelectorAll('.prog-link').forEach(el => {
    el.addEventListener('click', () => renderSession(orig[parseInt(el.dataset.idx, 10)]));
  });
}

// Affiche la conversation complete d'une leçon passee
let progressBackList = null;
function renderSession(s) {
  const box = $('progress-content');
  $('progress-title').innerHTML = '📖 ' + escapeHtml((s && s.topic) || 'Leçon');
  const back = document.createElement('button');
  back.className = 'btn';
  back.textContent = '◀ Toutes les leçons';
  back.addEventListener('click', () => {
    $('progress-title').innerHTML = '📊 Progression &amp; historique';
    openProgress();
  });
  box.innerHTML = '';
  box.appendChild(back);
  // Bilan pedagogique (genere a l'archivage) : reussites + points a retravailler
  const reussi = Array.isArray(s && s.reussi) ? s.reussi : [];
  const trav = Array.isArray(s && s.a_travailler) ? s.a_travailler : [];
  if (reussi.length || trav.length) {
    box.insertAdjacentHTML('beforeend', `<div class="prog-bilan">` +
      (reussi.length ? `<p>✅ <strong>Bien compris :</strong> ${escapeHtml(reussi.join(' · '))}</p>` : '') +
      (trav.length ? `<p>🔧 <strong>À retravailler :</strong> ${escapeHtml(trav.join(' · '))}</p>` : '') +
      `</div>`);
  }
  const msgs = (s && s.messages) || [];
  if (!msgs.length) {
    box.insertAdjacentHTML('beforeend', '<p class="hint">Pas de détails gardés pour cette leçon (elle date d\'avant la mise à jour).</p>');
    return;
  }
  const list = document.createElement('div');
  list.className = 'hist-list';
  for (const m of msgs) {
    const el = document.createElement('div');
    el.className = 'hist-msg ' + (m.role === 'user' ? 'user' : 'assistant');
    el.innerHTML = `<span class="hist-who">${m.role === 'user' ? '🧒 ' + escapeHtml(currentProfile ? currentProfile.name : 'Enfant') : '🌟 Lumi'}</span><div class="hist-text">${m.role === 'user' ? escapeHtml(m.content || '') : renderMarkdown(m.content || '')}</div>`;
    list.appendChild(el);
  }
  box.appendChild(list);
}

$('btn-progress').addEventListener('click', () => openProgress());
$('btn-progress-close').addEventListener('click', () => {
  $('progress-modal').classList.add('hidden');
  $('progress-title').innerHTML = '📊 Progression &amp; historique';
});

// ---------- Espace parent ----------
$('btn-parent').addEventListener('click', () => {
  $('parent-modal').classList.remove('hidden');
  $('parent-content').innerHTML = `
    <p class="hint">Petite question de vérification (les parents sauront 😉) :</p>
    <div class="video-search">
      <input id="parent-gate" type="number" placeholder="Combien font 6 × 7 ?">
      <button id="btn-parent-enter" class="btn btn-primary">Entrer</button>
    </div>`;
  $('btn-parent-enter').addEventListener('click', enterParentArea);
  $('parent-gate').addEventListener('keydown', (e) => { if (e.key === 'Enter') enterParentArea(); });
  $('parent-gate').focus();
});
$('btn-parent-close').addEventListener('click', () => $('parent-modal').classList.add('hidden'));

function enterParentArea() {
  const v = parseInt($('parent-gate').value, 10);
  if (v !== 42) {
    $('parent-content').insertAdjacentHTML('beforeend', '<p class="hint">Ce n\'est pas la bonne réponse 🙂</p>');
    return;
  }
  renderParentArea();
}

async function renderParentArea() {
  const box = $('parent-content');
  box.innerHTML = '<p class="hint">Chargement… ⏳</p>';
  let list = [];
  try { list = (await (await fetch('/api/profiles')).json()) || []; } catch {}
  const kids = list.filter(p => p && p.id);
  if (!kids.length) { box.innerHTML = '<p class="hint">Aucun profil enfant pour le moment.</p>'; return; }

  let html = '';
  const now = Date.now();
  for (const kid of kids) {
    let d = null;
    try { d = await (await fetch('/api/child?id=' + encodeURIComponent(kid.id))).json(); } catch {}
    const sessions = (d && d.sessions) || [];
    const answers = sessions.reduce((a, s) => a + (Number(s.count) || 0), 0);
    const quizzes = sessions.filter(s => s.type === 'quiz');
    const last7 = sessions.filter(s => { const t = Date.parse(s.date || ''); return t && (now - t) < 7 * 864e5; });
    const weak = quizzes.filter(s => s.count > 0 && s.score / s.count < 0.6);

    html += `<div class="parent-kid">
      <h3>${kid.photo ? `<img src="${escapeHtml(kid.photo)}" class="pill-photo" alt="">` : ''} ${escapeHtml(kid.name)} <span class="badge">${escapeHtml(kid.age)} ans</span></h3>
      <div class="parent-stats">
        <span class="stat"><strong>${sessions.length}</strong><small>leçons + interros</small></span>
        <span class="stat"><strong>${answers}</strong><small>réponses de Lumi</small></span>
        <span class="stat"><strong>${quizzes.length}</strong><small>interros</small></span>
        <span class="stat"><strong>${last7.length}</strong><small>sur 7 jours</small></span>
      </div>`;

    if (weak.length) {
      html += '<p class="parent-weak">⚠️ <strong>À revoir :</strong> ' + weak.slice(0, 5).map(s => escapeHtml(s.topic)).join(' · ') + '</p>';
    }
    if (quizzes.length) {
      const avg = quizzes.reduce((a, s) => a + (s.count ? s.score / s.count : 0), 0) / quizzes.length;
      html += `<p class="parent-line">🎯 Interros : ${Math.round(avg * 100)}% de bonnes réponses en moyenne</p>`;
    }
    if (!sessions.length) {
      html += '<p class="parent-line">Pas encore d\'activité enregistrée.</p>';
    } else {
      html += '<ul class="prog-list">';
      for (const s of sessions.slice().reverse().slice(0, 10)) {
        const sc = s.type === 'quiz' && s.count ? ` · ${s.score}/${s.count} ✅` : '';
        const reussi = Array.isArray(s.reussi) && s.reussi.length ? `<span class="prog-extra">✅ ${escapeHtml(s.reussi.join(' · '))}</span>` : '';
        const trav = Array.isArray(s.a_travailler) && s.a_travailler.length ? `<span class="prog-extra">🔧 <strong>À retravailler :</strong> ${escapeHtml(s.a_travailler.join(' · '))}</span>` : '';
        html += `<li class="prog-item"><span class="prog-topic">${escapeHtml(s.topic)}</span><span class="prog-meta">${s.count} échanges · ${formatDate(s.date)}${sc}</span>${reussi}${trav}</li>`;
      }
      html += '</ul>';
    }
    html += '</div>';
  }
  box.innerHTML = html;
}

// ---------- Démarrage ----------
// Si l'app est protégée par un code d'accès (mode hébergé), on l'affiche
// d'abord ; sinon on ouvre directement l'écran des profils.
async function initApp() {
  try {
    const g = await (await fetch('/api/gate')).json();
    if (g.locked && !g.open) {
      $('screen-gate').classList.remove('hidden');
      $('gate-code').focus();
      return;
    }
  } catch {}
  $('screen-profile').classList.remove('hidden');
  fetchProfiles().then(() => renderProfiles());
}
function enterGate() {
  const code = $('gate-code').value.trim();
  if (!code) return;
  fetch('/api/unlock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  }).then(r => {
    if (r.ok) {
      $('screen-gate').classList.add('hidden');
      $('screen-profile').classList.remove('hidden');
      fetchProfiles().then(() => renderProfiles());
    } else {
      $('gate-error').textContent = 'Code incorrect 🙂';
    }
  }).catch(() => { $('gate-error').textContent = 'Impossible de contacter Lumi.'; });
}
$('btn-gate-enter').addEventListener('click', enterGate);
$('gate-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') enterGate(); });
initApp();
if ('speechSynthesis' in window) speechSynthesis.getVoices();
