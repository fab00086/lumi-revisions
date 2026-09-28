'use strict';

// ---------- Raccourcis ----------
const $ = (id) => document.getElementById(id);
let currentProfile = null;
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

async function fetchProfiles() {
  try {
    const r = await fetch('/api/profiles');
    let list = await r.json();
    if (!Array.isArray(list) || !list.length) {
      // migration depuis l'ancien stockage local du navigateur
      try { list = JSON.parse(localStorage.getItem('lumiprofiles') || '[]'); } catch { list = []; }
      if (list.length) saveProfiles(list);
    }
    profilesCache = (Array.isArray(list) ? list : []).map(p => { if (!p.id) p.id = generateId(); return p; });
  } catch {}
}

function loadProfiles() { return profilesCache; }
function saveProfiles(list) {
  profilesCache = list;
  fetch('/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profiles: list })
  }).catch(() => {});
}

function renderProfiles() {
  const box = $('profiles');
  const list = loadProfiles();
  box.innerHTML = '';
  list.forEach((p, i) => {
    const el = document.createElement('button');
    el.className = 'profile-pill';
    el.innerHTML = `${p.photo ? `<img src="${p.photo}" class="pill-photo" alt="">` : ''} ${escapeHtml(p.name)} <span class="badge">${p.age} ans</span> <span class="del" data-i="${i}">✕</span>`;
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('del')) {
        e.stopPropagation();
        list.splice(i, 1); saveProfiles(list); renderProfiles();
        return;
      }
      startChat(p);
    });
    box.appendChild(el);
  });
}

// Photo de profil (selfie)
let pendingPhoto = null; // dataURL jpeg

$('profile-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('pf-name').value.trim();
  const age = parseInt($('pf-age').value, 10);
  if (!name || !age) return;
  const photo = pendingPhoto;
  const list = loadProfiles();
  const child = { id: generateId(), name, age, photo: photo || null };
  list.push(child);
  saveProfiles(list);
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
      saved = await r.json();
    } catch {}
  }

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
async function saveChild() {
  if (!currentProfile || !currentProfile.id) return;
  try {
    await fetch('/api/child', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: currentProfile.id, name: currentProfile.name, age: currentProfile.age, history })
    });
  } catch {}
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
  if (!clean && !imageBase64) return;
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
      body: JSON.stringify({ message: clean, image: imageBase64 || null, profile: currentProfile, history })
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || ('HTTP ' + r.status));
    }
    // Lecture du flux : {type: status|start|delta|error|done}
    const bubble = addBubble('assistant', '');
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '', sources = [], hadError = null, firstDelta = true;
    while (true) {
      const { done, value } = await reader.read();
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
    history.push({ role: 'user', content: clean || '[photo du cahier]' });
    history.push({ role: 'assistant', content: full });
    saveChild();
    speak(full);
  } catch (err) {
    removeTyping();
    setStatus("Je t'écoute 👂");
    addBubble('assistant', '⚠️ Impossible de joindre Lumi : ' + escapeHtml(String(err)));
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

// Safari/iOS : le premier appel a speak() doit partir d'un geste de
// l'utilisateur, sinon la voix reste muette. On "debloque" la voix
// au premier toucher de l'ecran (son inaudible, volume 0).
let speechUnlocked = false;
function unlockSpeech() {
  if (speechUnlocked || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
    speechUnlocked = true;
    speechSynthesis.getVoices(); // iOS charge les voix tres tard
  } catch {}
}
document.addEventListener('pointerdown', unlockSpeech);
document.addEventListener('keydown', unlockSpeech);

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
  try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch {}
  $('avatar').classList.remove('talking');
  $('btn-stop').classList.add('hidden');
  setStatus("Je t'écoute 👂");
}

// Appuie sur l'avatar = couper la parole aussi
$('avatar').addEventListener('click', stopSpeech);
$('btn-stop').addEventListener('click', stopSpeech);

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  try {
    text = cleanForSpeech(text);
    if (!text) return;
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
          $('avatar').classList.remove('talking');
          $('btn-stop').classList.add('hidden');
          setStatus("Je t'écoute 👂");
        }
      };
      for (const part of parts) {
        const u = new SpeechSynthesisUtterance(part);
        u.lang = 'fr-FR';
        u.rate = voiceRate || 1;
        if (voice) u.voice = voice;
        u.onstart = () => {
          if (gen === speakGen) {
            $('avatar').classList.add('talking');
            $('btn-stop').classList.remove('hidden');
            setStatus('Je parle 🗣️ (appuie sur ✋ pour me couper)');
          }
        };
        u.onend = done;
        u.onerror = done;
        speechSynthesis.speak(u);
      }
    };
    // iOS : speak() lance juste apres cancel() est ignore -> petit delai
    setTimeout(start, 80);
  } catch {}
}

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
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) {
  recog = new SR();
  recog.lang = 'fr-FR';
  recog.continuous = false;
  recog.interimResults = false;
  recog.onresult = (e) => {
    const t = e.results[0][0].transcript;
    $('input').value = t;
    send(t);
  };
  recog.onerror = (e) => {
    $('btn-mic').classList.remove('recording');
    const err = e && e.error;
    if (err === 'not-allowed' || err === 'service-not-allowed') {
      if (isIOS) {
        addBubble('assistant', "🎤 Je ne peux pas t'entendre pour l'instant ! Il faut approuver le certificat de Lumi : ouvre la page d'accueil, bouton « 📱 Connecter un téléphone », puis « 🍎 Aide iPhone ». Une seule fois, promis ! 🙏");
      } else {
        addBubble('assistant', "🎤 Le micro est bloque par le navigateur. Clique sur le petit cadenas dans la barre d'adresse et autorise le micro. 🙏");
      }
    } else if (err === 'no-speech') {
      addBubble('assistant', "🎤 Je n'ai rien entendu ! Appuie sur le micro et parle un peu plus fort, pres du telephone. 😊");
    } else if (err === 'network') {
      addBubble('assistant', "🎤 Petit probleme de reseau avec la reconnaissance vocale. Reessaie dans un instant. 🙏");
    } else if (err) {
      addBubble('assistant', "🎤 Le micro n'a pas fonctionne (" + err + "). Tu peux aussi ecrire ta question. 🙏");
    }
  };
  recog.onend = () => $('btn-mic').classList.remove('recording');
}
// Sur iOS, Safari exige que la permission micro soit accordee AVANT
// SpeechRecognition (sinon il echoue en silence). On demande le micro
// une premiere fois via getUserMedia pour declencher la boite de
// permission, puis l'appui suivant sur le micro fonctionnera.
let micPermissionOk = false;
async function warmMicPermission() {
  if (micPermissionOk || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return true;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(t => t.stop());
    micPermissionOk = true;
    return true;
  } catch {
    return false;
  }
}
$('btn-mic').addEventListener('click', async () => {
  if (recog && $('btn-mic').classList.contains('recording')) { recog.stop(); return; }
  stopSpeech(); // appuyer sur le micro coupe la voix de Lumi
  if (!recog) {
    addBubble('assistant', '🎤 Le micro ne marche pas sur ce navigateur (souvent il faut Chrome/Edge, et une connexion HTTPS sur téléphone). En attendant, écris ta question. 🙏');
    return;
  }
  if ($('btn-mic').classList.contains('recording')) { recog.stop(); return; }
  $('btn-mic').classList.add('recording');
  setStatus("Je t'écoute… 🎤");
  const ok = await warmMicPermission();
  if (!ok) {
    $('btn-mic').classList.remove('recording');
    if (isIOS) {
      addBubble('assistant', "🎤 Je ne peux pas t'entendre pour l'instant ! Il faut d'abord approuver le certificat de Lumi : page d'accueil → « 📱 Connecter un téléphone » → « 🍎 Aide iPhone ». Une seule fois, promis ! 🙏");
    } else {
      addBubble('assistant', "🎤 Le micro est bloque. Clique sur le cadenas dans la barre d'adresse et autorise le micro. 🙏");
    }
    return;
  }
  try { recog.start(); } catch {
    // Sur iOS, start() juste apres une boite de permission peut echouer :
    // on previent l'enfant de reappluyer une fois.
    $('btn-mic').classList.remove('recording');
    addBubble('assistant', "🎤 Le micro est maintenant active ! Reappuie sur le bouton micro et parle. 😊");
  }
});

// ---------- Envoi ----------
$('btn-send').addEventListener('click', () => send($('input').value));
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') send($('input').value); });

// ---------- Retour ----------
$('btn-back').addEventListener('click', () => {
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
let quizData = null, quizIdx = 0, quizScore = 0, quizTopicUsed = '';

$('btn-quiz').addEventListener('click', () => {
  $('quiz-modal').classList.remove('hidden');
  $('quiz-area').innerHTML = '<p class="hint">Choisis un sujet et Lumi te pose 5 questions ! 🌟</p>';
  $('quiz-progress').textContent = '';
  if (lastTopic()) $('quiz-topic').value = lastTopic();
});
$('btn-quiz-close').addEventListener('click', () => {
  $('quiz-modal').classList.add('hidden');
  stopSpeech();
});

async function startQuiz() {
  const topic = $('quiz-topic').value.trim();
  if (!topic || !currentProfile) { $('quiz-area').innerHTML = '<p class="hint">Écris un sujet d\'abord 🙂</p>'; return; }
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
    if (!j.quiz || !j.quiz.length) {
      $('quiz-area').innerHTML = '<p class="hint">⚠️ Je n\'ai pas réussi à préparer les questions. Essaie encore !</p>';
      $('quiz-topic-row').classList.remove('hidden');
      return;
    }
    quizData = j.quiz; quizIdx = 0; quizScore = 0;
    renderQuizQuestion();
  } catch {
    $('quiz-area').innerHTML = '<p class="hint">⚠️ Impossible de préparer l\'interro.</p>';
    $('quiz-topic-row').classList.remove('hidden');
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

// ---------- QR code de connexion (telephone) ----------
async function loadConnectQr() {
  try {
    const r = await fetch('/api/qr');
    const j = await r.json();
    if (j.qr) {
      $('connect-qr').src = j.qr;
      $('connect-url').textContent = 'Sur le téléphone (même Wi-Fi), ouvre : ' + (j.url || '');
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
  if (!currentProfile) return;
  const name = currentProfile.name;
  if (currentProfile.id) {
    try {
      await fetch('/api/child', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: currentProfile.id, name, age: currentProfile.age, history, action: 'archive' })
      });
    } catch {}
  }
  history = [];
  $('chat').innerHTML = '';
  const greeting = `C'est parti pour une nouvelle leçon, ${escapeHtml(name)} ! 👋 Montre-moi ton devoir (photo 📷) ou pose-moi une question 😊`;
  addBubble('assistant', greeting);
  speak(`C'est parti pour une nouvelle leçon, ${name} ! Montre-moi ton devoir, ou pose-moi une question.`);
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
  const sessions = (d.sessions || []).slice().reverse();
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
    const orig = (d.sessions || []);
    sessions.forEach((s, k) => {
      const idx = orig.length - 1 - k;
      html += `<li><button class="prog-item prog-link" data-idx="${idx}"><span class="prog-topic">${escapeHtml(s.topic)}</span><span class="prog-meta">${s.count} réponses · ${formatDate(s.date)}</span></button></li>`;
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
    $('parent-content').innerHTML += '<p class="hint">Ce n\'est pas la bonne réponse 🙂</p>';
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
      <h3>${kid.photo ? `<img src="${escapeHtml(kid.photo)}" class="pill-photo" alt="">` : ''} ${escapeHtml(kid.name)} <span class="badge">${kid.age} ans</span></h3>
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
        html += `<li class="prog-item"><span class="prog-topic">${escapeHtml(s.topic)}</span><span class="prog-meta">${s.count} échanges · ${formatDate(s.date)}${sc}</span></li>`;
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
