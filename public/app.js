'use strict';

// ---------- Raccourcis ----------
const $ = (id) => document.getElementById(id);
// Le menu se referme après le choix d'un outil, y compris sur téléphone.
$('chat-tools')?.addEventListener('click', (event) => {
  if (event.target.closest('button')) $('chat-tools').open = false;
});
document.addEventListener('click', (event) => {
  const tools = $('chat-tools');
  if (tools?.open && !tools.contains(event.target)) tools.open = false;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('chat-tools')?.open) {
    $('chat-tools').open = false;
    $('chat-tools').querySelector('summary').focus();
  }
});
let currentProfile = null;
let adminTestMode = false;
let chatGeneration = 0;
let activeChat = null;
let chatLoading = false;
let archiving = false;
function cancelChat() {
  stopListening();
  stopSpeech();
  lastSpeechText = '';
  if (voiceAudioUrl) { URL.revokeObjectURL(voiceAudioUrl); voiceAudioUrl = null; }
  voiceAudioText = '';
  if (voiceAudio) { voiceAudio.src = '/audio-ready.wav'; voiceAudio.hidden = true; }
  $('voice-playback').classList.add('hidden');
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
// Message d'erreur discret dans la page (remplace alert(), brusque pour un enfant)
let toastTimer = null;
function toast(msg, duration = 4000) {
  let t = $('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), duration);
}
// Erreurs reecrites en langage enfant : jamais de texte technique brut.
function friendlyError(err) {
  const e = err || {};
  if (e.name === 'AbortError') return "Oups, Lumi a mis trop de temps à répondre. Réessaie ! 🤔";
  if (e instanceof TypeError && String(e.message).includes('fetch')) return "Oups, Lumi n'arrive pas à joindre le serveur. Vérifie ta connexion et réessaie ! 📶";
  return "Oups, Lumi n'arrive pas à répondre. Réessaie, ça va marcher ! 😊";
}
// Un message venu du serveur peut etre affiche tel quel ; jamais `err` brut.
function safeText(err) {
  return (err && typeof err.message === 'string' && err.message && !/^\s*(AbortError|TypeError|Error)/.test(err.message))
    ? escapeHtml(err.message)
    : friendlyError(err);
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
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/https?:\/\/\S+/g, '');
  try { t = t.replace(/\p{Extended_Pictographic}/gu, ''); } catch (e) {}
  // LaTeX : garde le contenu, jette les commandes (\frac{3}{4} -> 3 sur 4)
  t = t.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '$1 sur $2');
  t = t.replace(/\\sqrt\{([^{}]+)\}/g, 'racine de $1');
  t = t.replace(/\\(?:times|cdot)\b/g, ' fois ').replace(/\\div\b/g, ' divisé par ');
  t = t.replace(/\\[a-zA-Z]+/g, ' ');
  t = t.replace(/[${}\\]/g, ' ');
  t = t.replace(/[️‍\u{1F3FB}-\u{1F3FF}]/gu, '');
  t = t.replace(/\*\*(.+?)\*\*/g, '$1');
  t = t.replace(/\*([^*\n]+)\*/g, '$1');
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/^\s*[-•▪◦·]\s*/gm, '');
  t = t.replace(/^\s*#{1,6}\s*/gm, '');
  t = t.replace(/(\d)\s*\/\s*(\d)/g, '$1 sur $2');
  t = t.replace(/(\d)[.,](\d)/g, '$1 virgule $2');
  t = t.replace(/[×]/g, ' fois ').replace(/[÷]/g, ' divisé par ').replace(/=/g, ' égale ');
  t = t.replace(/[\/|_#\[\]<>*`]/g, ' ');
  t = t.replace(/[«»“”‘’]/g, '');
  // Les signes ne sont pas transmis aux voix qui les prononcent littéralement.
  t = t.replace(/[.,;:!?…()]+/g, '\n');
  t = t.replace(/[ \t]{2,}/g, ' ');
  return t.trim();
}

// ---------- Profils ----------
function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// Profils partages entre tous les appareils via le serveur
let profilesCache = [];
const pendingLessons = new Map();
let profileFetchGeneration = 0;

async function fetchProfiles() {
  const generation = ++profileFetchGeneration;
  try {
    const r = await fetch('/api/profiles');
    if (r.status === 401 && generation === profileFetchGeneration) {
      profilesCache = []; $('screen-profile').classList.add('hidden'); $('screen-gate').classList.remove('hidden');
      $('gate-error').textContent = 'Accès expiré ou bloqué. Entre ton code famille.'; return;
    }
    if (!r.ok) throw new Error('Chargement des profils impossible');
    let list = await r.json();
    if (generation !== profileFetchGeneration) return;
    // L'ancien stockage du navigateur appartient à la maison, jamais à une nouvelle famille.
    if (!Array.isArray(list) || !list.length) {
      const me = await (await fetch('/api/auth/me')).json();
      if (generation !== profileFetchGeneration) return;
      if (me.local === true) {
        try { list = JSON.parse(localStorage.getItem('lumiprofiles') || '[]'); } catch { list = []; }
        if (list.length) await saveProfiles(list);
      }
    }
    if (generation !== profileFetchGeneration) return;
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
    el.innerHTML = `${p.photo ? `<img src="${escapeHtml(p.photo)}" class="pill-photo" alt="">` : ''} ${escapeHtml(p.name)} <span class="badge">${escapeHtml(p.level || (p.age + ' ans'))}</span> <span class="del" data-i="${i}" title="Supprimer le profil de ${escapeHtml(p.name)}">✕</span>`;
    el.addEventListener('click', async (e) => {
      const del = e.target.closest('.del');
      if (del) {
        e.stopPropagation();
        // Confirme en 2 taps : le premier armе le bouton, le second supprime.
        if (!del.classList.contains('armed')) {
          del.classList.add('armed');
          del.textContent = 'Supprimer ?';
          setTimeout(() => { del.classList.remove('armed'); del.textContent = '✕'; }, 4000);
          return;
        }
        try { await saveProfiles(list.filter((_, index) => index !== i)); renderProfiles(); }
        catch (err) { toast("Oups, la suppression n'a pas marchée. Réessaie !"); }
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
  const level = $('pf-level').value || null;
  const list = loadProfiles();
  const child = { id: generateId(), name, age, level, photo: photo || null };
  try { await saveProfiles([...list, child]); }
  catch (err) { toast("Oups, le profil n'a pas pu être créé. Réessaie !"); return; }
  pendingPhoto = null;
  $('pf-photo-preview').classList.add('hidden');
  $('pf-photo-preview').removeAttribute('src');
  $('pf-photo-btn').textContent = '📷 Photo (selfie)';
  $('pf-name').value = ''; $('pf-age').value = ''; $('pf-level').value = '';
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
      // Sans ce reset, chatLoading resterait a true et l'app refuserait
      // tout envoi silencieusement jusqu'au rechargement.
      if (generation === chatGeneration) {
        chatLoading = false;
        currentProfile = null; // ne pas écraser une leçon dont le chargement a échoué
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
  const timeout = setTimeout(() => controller.abort(), imageBase64 ? 260000 : 130000);
  if (typeof stopListening === 'function') stopListening();
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
      throw new Error(j.error || 'Oups, Lumi n\'arrive pas à répondre. Réessaie, ça va marcher ! 😊');
    }
    if (generation !== chatGeneration) return;
    // Lecture du flux : {type: status|start|delta|error|done}
    const bubble = addBubble('assistant', '');
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '', sources = [], hadError = null, firstDelta = true;
    let userContent = clean || '[photo du cahier]', completed = false, userSaved = false;
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
        } else if (ev.type === 'photo' && typeof ev.userContent === 'string' && !userSaved) {
          userContent = ev.userContent;
          messages.push({ role: 'user', content: userContent });
          userSaved = true;
          try { await saveChild(profile, messages); }
          catch (err) { addBubble('assistant', '⚠️ ' + escapeHtml(err.message)); }
        } else if (ev.type === 'delta') {
          if (firstDelta) { firstDelta = false; removeTyping(); setStatus("Je t'écoute 👂"); }
          full += ev.text;
          bubble.innerHTML = renderMarkdown(full);
          const chat = $('chat'); chat.scrollTop = chat.scrollHeight;
        } else if (ev.type === 'error') {
          hadError = ev.error;
        } else if (ev.type === 'done') {
          completed = true;
          if (typeof ev.userContent === 'string') userContent = ev.userContent;
          sources = ev.sources || [];
        }
      }
    }
    removeTyping();
    setStatus("Je t'écoute 👂");

    if (hadError || !completed) { bubble.closest('.msg').remove(); addBubble('assistant', '⚠️ ' + escapeHtml(hadError || 'Réponse interrompue — réessaie.')); return; }
    if (!full) { bubble.closest('.msg').remove(); addBubble('assistant', '⚠️ Réponse vide — réessaie.'); return; }

    bubble.innerHTML = renderMarkdown(full);
    if (sources && sources.length) {
      const s = document.createElement('div');
      s.className = 'sources';
      s.innerHTML = '<strong>📚 Sources :</strong> ' + sources.map(x => `<a href="${escapeHtml(x.url)}" target="_blank" rel="noopener">${escapeHtml(x.title)}</a>`).join(' · ');
      bubble.parentElement.appendChild(s);
    }
    if (!userSaved) messages.push({ role: 'user', content: userContent });
    messages.push({ role: 'assistant', content: full });
    // Préparer la voix sans attendre l'aller-retour de sauvegarde au cloud.
    if (generation === chatGeneration) speak(full);
    try {
      await saveChild(profile, messages);
    } catch (err) {
      if (generation === chatGeneration) addBubble('assistant', '⚠️ ' + escapeHtml(err.message));
    }
  } catch (err) {
    if (generation !== chatGeneration) return;
    removeTyping();
    setStatus("Je t'écoute 👂");
    addBubble('assistant', '⚠️ ' + safeText(err));
  } finally {
    clearTimeout(timeout);
    if (activeChat === controller) activeChat = null;
    if (generation === chatGeneration && typeof micLiveResume === 'function') micLiveResume();
  }
}

function setStatus(txt) {
  $('teacher-status').textContent = txt;
  $('voice-feedback').textContent = txt;
}

// ---------- Voix (lecture + avatar qui parle) ----------
let voicePref = localStorage.getItem('lumivoice') || null;
let voiceMode = localStorage.getItem('lumivoiceengine') || 'server';
let voiceRate = parseFloat(localStorage.getItem('lumirate') || '1.0');

function frenchVoices() {
  if (!('speechSynthesis' in window)) return [];
  return (speechSynthesis.getVoices() || []).filter(v => v.lang && v.lang.toLowerCase().startsWith('fr'));
}

// Choisit la meilleure voix : les voix "naturelles" d'abord
function pickBestVoice() {
  if (voicePref === '__auto__') return null;
  const fr = frenchVoices();
  if (!fr.length) return null;
  if (voicePref) { const chosen = fr.find(v => v.name === voicePref); if (chosen) return chosen; }
  // Sur mobile, laisser le système choisir évite de forcer une voix distante
  // ou une ancienne référence indisponible après une mise à jour du téléphone.
  if (/iPad|iPhone|iPod|Android/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return null;
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
  sel.innerHTML = '<option value="__server__">Lumi — voix française</option><option value="__auto__">Voix du téléphone (automatique)</option>';
  sel.value = voiceMode === 'server' ? '__server__' : (voicePref || '__auto__');
  if (!fr.length) {
    return;
  }
  fr.forEach(v => {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = `${v.name}${v.lang === 'fr-FR' ? '' : ' (' + v.lang + ')'}${(voiceMode !== 'server' && !voicePref && v === best) ? ' ✨' : ''}`;
    if (voiceMode !== 'server' && voicePref !== '__auto__' && (voicePref ? v.name === voicePref : v === best)) o.selected = true;
    sel.appendChild(o);
  });
}

$('voice-select').addEventListener('change', (e) => {
  voicePref = e.target.value;
  voiceMode = voicePref === '__server__' ? 'server' : 'native';
  localStorage.setItem('lumivoiceengine', voiceMode);
  localStorage.setItem('lumivoice', voicePref);
  speak('Bonjour ! Voici ma nouvelle voix.');
});

$('rate-slider').addEventListener('input', (e) => {
  voiceRate = parseFloat(e.target.value);
  $('rate-val').textContent = voiceRate.toFixed(2);
  localStorage.setItem('lumirate', String(voiceRate));
});

populateVoiceSelect();
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
let voiceAudio = null;
let voiceAudioUrl = null;
let voiceAudioText = '';
let voiceAudioCreated = 0;
let voiceAudioBusy = false;
let voiceRequest = null;
function setAudioSession(type) {
  try { if (navigator.audioSession) navigator.audioSession.type = type; } catch { /* API facultative. */ }
}
function unlockVoiceAudio() {
  if (!voiceAudio) {
    voiceAudio = new Audio('/audio-ready.wav');
    voiceAudio.id = 'lumi-audio'; voiceAudio.hidden = true;
    voiceAudio.onplay = () => {
      stopListening(); setAudioSession('playback'); voiceAudioBusy = true;
      voiceAudio.onended = () => {
        voiceAudioBusy = false; $('avatar').classList.remove('talking'); $('btn-stop').classList.add('hidden');
        setStatus("Je t'écoute 👂"); if (typeof micLiveResume === 'function') micLiveResume();
      };
    };
    $('voice-playback')?.appendChild?.(voiceAudio);
  }
  // Native media uses the same output as the melody confirmed on the iPhone.
  // A short silent WAV activates this very element within the button touch.
  if (!voiceAudioUrl) return voiceAudio.play();
  return Promise.resolve();
}
async function speakAudio(text) {
  stopListening();
  stopSpeech();
  setAudioSession('playback');
  const gen = ++speakGen;
  voiceAudioBusy = true;
  const controller = new AbortController();
  voiceRequest = controller;
  $('btn-stop').classList.remove('hidden');
  setStatus('Lumi prépare sa voix…');
  const timeout = setTimeout(() => controller.abort(), 90000);
  try {
    const cached = voiceAudioUrl && voiceAudioText === text && Date.now() - voiceAudioCreated < 240000;
    // Le pré-déverrouillage peut rester bloqué sur mobile : il ne doit pas bloquer la requête vocale.
    if (!cached) unlockVoiceAudio().catch(() => {});
    if (!cached) {
    const response = await fetch('/api/speech', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 3000), format: 'url' }), signal: controller.signal,
    });
    if (!response.ok) throw Error((await response.json()).error || 'Voix indisponible.');
    const result = await response.json();
    if (!/^\/api\/speech\/audio\/[a-f0-9]{48}$/.test(result.url)) throw Error('Fichier vocal indisponible.');
    if (gen !== speakGen) return;
    if (voiceAudioUrl) URL.revokeObjectURL(voiceAudioUrl);
    voiceAudioUrl = result.url;
    voiceAudioCreated = Date.now();
    voiceAudioText = text;
    }
    // Réaffecter aussi la source lors d'une relance après retour au premier plan (Safari/PWA).
    voiceAudio.src = voiceAudioUrl;
    voiceAudio.controls = true; voiceAudio.hidden = false; voiceAudio.muted = false;
    $('voice-playback').classList.remove('hidden');
    voiceAudio.currentTime = 0;
    voiceAudio.volume = 1;
    voiceAudio.playbackRate = Math.max(0.6, Math.min(1.5, voiceRate || 1));
    voiceAudio.onended = () => {
      if (gen !== speakGen) return;
      voiceAudioBusy = false;
      $('avatar').classList.remove('talking');
      $('btn-stop').classList.add('hidden');
      setStatus("Je t'écoute 👂");
      if (typeof micLiveResume === 'function') micLiveResume();
    };
    voiceAudio.onerror = () => {
      if (gen !== speakGen) return;
      stopSpeech();
      setStatus('Lecture audio interrompue. Appuie sur Écouter Lumi pour réessayer.');
      if (typeof micLiveResume === 'function') micLiveResume();
    };
    // When Safari requires another touch, retry plays this cached file directly.
    await voiceAudio.play();
    if (gen !== speakGen) return;
    $('avatar').classList.add('talking');
    setStatus('Je parle 🗣️ (appuie sur ✋ pour me couper)');
  } catch (error) {
    if (gen !== speakGen) return;
    voiceAudioBusy = false;
    $('btn-stop').classList.add('hidden');
    setStatus(error.name === 'NotAllowedError' ? 'La voix est prête. Appuie sur 🔊 Écouter Lumi pour la lancer.' : error.name === 'AbortError' ? 'Voix trop longue à préparer. Appuie sur Écouter Lumi pour réessayer.' : error.message);
    if (typeof micLiveResume === 'function') micLiveResume();
  } finally {
    clearTimeout(timeout);
    if (voiceRequest === controller) voiceRequest = null;
  }
}
$('btn-listen').addEventListener('click', () => speak(lastSpeechText || 'Bonjour ! Je suis Lumi.'));
$('btn-test-voice').addEventListener('click', () => speak('Bonjour ! Je suis Lumi. Est-ce que tu entends ma voix ?'));

// Decoupe le texte aux fins de phrases : iOS coupe le son sur les
// textes longs, il faut plusieurs morceaux courts.
function splitForSpeech(text, maxLen = 160) {
  const out = [];
  let cur = '';
  const push = () => { const t = cur.trim(); if (t) out.push(t); cur = ''; };
  for (const w of String(text).replace(/\n/g, ' \n ').split(/[^\S\n]+/)) {
    if (w === '\n') { push(); continue; }
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
  voiceAudioBusy = false;
  if (voiceRequest) { voiceRequest.abort(); voiceRequest = null; }
  if (voiceAudio) { voiceAudio.onended = null; voiceAudio.onerror = null; voiceAudio.pause(); }
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
  if (typeof voiceMode !== 'undefined' && voiceMode === 'server') {
    if (lastSpeechText) speakAudio(lastSpeechText);
    return;
  }
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
    setAudioSession('playback');
    // cancel() vide la file, mais ne retire pas l'état pause du navigateur.
    // Reprendre dans le toucher permet au bouton de sortir de cet état.
    if (speechSynthesis.paused) speechSynthesis.resume();
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
        u.volume = 1;
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
      setStatus('Voix non démarrée : monte le volume, coupe le mode silencieux, puis appuie sur 🔊 Écouter Lumi.');
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

// La voix se lance avec un vrai bouton. Un énoncé muet au premier toucher
// peut prendre la sortie audio pendant le démarrage du micro sur iPhone.

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
  setLiveMic(false);
  stopSpeech();
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

// Bouton 📷 du cahier : la photo passe par la prévisualisation avant d'aller à Lumi
$('btn-camera').addEventListener('click', () => openCamera(showNotebookPhotoPreview, 'environment', $('mic')));

// Galerie / téléphone (cahier)
$('mic').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  compressImage(f, 2000, 0.92).then(b64 => {
    if (b64) finishCamera(b64);
    else toast("Oups, impossible de lire cette photo. Réessaie ! 📷");
  });
  e.target.value = '';
});

// ---------- Prévisualisation de la photo du cahier ----------
let pendingNotebookPhoto = null;

function showNotebookPhotoPreview(base64) {
  if (!base64) return;
  pendingNotebookPhoto = base64;
  $('photo-preview-img').src = 'data:image/jpeg;base64,' + base64;
  $('photo-preview-modal').classList.remove('hidden');
}

function hideNotebookPhotoPreview() {
  $('photo-preview-modal').classList.add('hidden');
  $('photo-preview-img').removeAttribute('src');
  pendingNotebookPhoto = null;
}

// ✅ Envoyer : la photo part à Lumi (le tuteur)
$('btn-photo-send').addEventListener('click', () => {
  const b64 = pendingNotebookPhoto;
  hideNotebookPhotoPreview();
  if (b64) send('', b64);
});

// 🔄 Refaire : rouvre la caméra (ou l'appareil photo natif sur iPhone),
// dans le geste utilisateur du clic, donc Safari autorise toujours.
$('btn-photo-retake').addEventListener('click', () => {
  hideNotebookPhotoPreview();
  openCamera(showNotebookPhotoPreview, 'environment', $('mic'));
});

// ✕ Annuler
$('btn-photo-preview-close').addEventListener('click', hideNotebookPhotoPreview);

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
let emptyMicSessions = 0;
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
    ? "Sur iPhone : ouvre Lumi directement dans Safari via le QR code (pas dans le navigateur d'une autre application, ni l'adresse https://192.168…). Autorise le micro dans les réglages du site et active Siri et la Dictée dans les Réglages de l'iPhone."
    : "Autorise le microphone dans les réglages du site de ton navigateur.";
  const messages = {
    'not-allowed': help,
    'service-not-allowed': help,
    'audio-capture': 'Vérifie que le microphone est disponible et autorisé, puis réessaie.',
    'no-speech': "Je n'ai rien entendu. Appuie sur le micro et parle près du téléphone.",
    'network': 'La reconnaissance vocale ne répond pas. Vérifie ta connexion et réessaie.',
    'timeout': "Le micro ne répond plus. Appuie à nouveau sur 🎤. Si cela continue, recharge la page dans Safari ou utilise la dictée du clavier.",
  };
  addBubble('assistant', '🎤 ' + (messages[error] || 'Le micro est indisponible. Tu peux écrire ta question ou utiliser la dictée du clavier.'));
}
function setLiveMic(on) {
  liveMic = on;
  emptyMicSessions = 0;
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
  if (typeof voiceAudioBusy !== 'undefined' && voiceAudioBusy) return;
  if (liveMic && !speechUtterances.length) micLiveRestart(350);
}
function startListening() {
  if (typeof voiceAudioBusy !== 'undefined' && voiceAudioBusy) return;
  if (recog || chatLoading || activeChat || archiving || document.hidden || speechUtterances.length) return;
  setAudioSession('play-and-record');
  if (!window.isSecureContext) {
    setLiveMic(false);
    addBubble('assistant', '🎤 Ouvre le panneau « Connecter un téléphone » sur le PC et scanne le QR code HTTPS, puis ouvre-le dans Safari.');
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
    session.interimResults = true;
    session.onstart = () => {
      if (recog === session) setStatus(liveMic ? 'Mode discussion 🎙️ — parle, je t’écoute !' : "Je t'écoute… 🎤");
    };
    session.onresult = (e) => {
      if (recog !== session || generation !== chatGeneration) return;
      const result = e.results?.[e.resultIndex || 0];
      const text = String(result?.[0]?.transcript || '').trim();
      if (!text) return;
      if (result?.isFinal === false) {
        $('input').value = text;
        setStatus('Je t’entends 🎤 — tu peux toucher Envoyer dès que ta phrase est prête.');
        return;
      }
      emptyMicSessions = 0;
      stopListening();
      $('input').value = text;
      send(text);
    };
    session.onerror = (e) => {
      if (recog !== session) return;
      stopListening();
      if (e.error !== 'aborted') micError(e.error);
    };
    session.onspeechend = () => { if (recog === session) { try { session.stop?.(); } catch {} } };
    session.onend = () => {
      if (recog !== session) return;
      stopListening();
      if (liveMic) {
        if (++emptyMicSessions >= 3) { micError('timeout'); return; }
        micLiveRestart(); return;
      }
      setStatus("Je t'écoute 👂");
    };
    $('btn-mic').classList.add('recording');
    setStatus(liveMic ? 'Mode discussion 🎙️ — parle, je t’écoute !' : 'Autorise le micro si Safari le demande, puis parle.');
    micTimer = setTimeout(() => {
      if (recog !== session) return;
      stopListening();
      // Une session sans aucun événement est un blocage Safari, pas un silence.
      // Arrêter au lieu de boucler indéfiniment en affichant « je t'écoute ».
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
  if (chatLoading || activeChat || archiving) {
    setStatus('Attends la fin du chargement ou de la réponse, puis appuie sur 🎙️.');
    return;
  }
  stopListening(); // le mode discussion remplace la session « une question »
  setLiveMic(true);
  stopSpeech();
  setStatus('Mode discussion 🎙️ — parle, je t’écoute tout le temps !');
  startListening();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  setLiveMic(false);
  stopSpeech();
});
$('btn-mic').addEventListener('click', () => {
  if (recog) { setLiveMic(false); setStatus('Micro arrêté. Appuie sur 🎤 pour une question ou 🎙️ pour discuter.'); return; }
  setLiveMic(false); // annule aussi toute relance automatique encore en attente
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
  if (!w) { toast('Autorise les fenêtres pop-up pour imprimer.'); return; }
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
    const timer = setTimeout(() => resolve('permission micro en attente : accepte la demande dans Safari puis réessaie'), 12000);
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then((s) => {
        clearTimeout(timer);
        const label = (s.getAudioTracks()[0] || {}).label || 'micro';
        s.getTracks().forEach((t) => t.stop());
        resolve('ok (' + label + ')');
      })
      .catch((e) => { clearTimeout(timer); resolve('refus ou erreur : ' + (e.name || e.message)); });
  });
}

function diagSR() {
  return new Promise((resolve) => {
    const SRc = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SRc) return resolve('reconnaissance vocale absente de ce navigateur (iOS trop ancien ou navigateur limite)');
    let done = false, started = false, timer;
    const finish = (msg) => { if (!done) { done = true; clearTimeout(timer); try { r.abort(); } catch {} resolve(msg); } };
    let r;
    try {
      r = new SRc();
    } catch (e) {
      return resolve('impossible a creer : ' + e.message);
    }
    r.lang = 'fr-FR';
    r.onstart = () => { started = true; setStatus('Diagnostic micro : dis « bonjour » maintenant.'); };
    r.onerror = (e) => finish('erreur : ' + e.error);
    r.onresult = () => finish('voix reconnue correctement');
    r.onend = () => finish('demarre puis s\'est arrete (tu n\'as rien dit ?)');
    try {
      r.start();
    } catch (e) {
      return finish('lancement impossible : ' + e.message);
    }
    timer = setTimeout(() => finish(started ? 'micro démarré, aucun mot reconnu : réessaie en disant bonjour' : 'aucune réponse du micro : ouvre Safari et vérifie Siri/Dictée'), 10000);
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
  setLiveMic(false);
  stopSpeech();
  // Démarrer pendant le clic, avant tout await : Safari exige ce geste.
  const recognitionTest = diagSR();
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
  add(null, 'Appareil', (isIOS ? 'iPhone/iPad · version iOS à vérifier dans Réglages du téléphone' : 'autre appareil') + ' · ' + (window.isSecureContext ? 'HTTPS sécurisé' : 'PAS en HTTPS') + ' · ' + location.hostname);

  add(!!('speechSynthesis' in window), 'Voix de synthèse disponible', 'speechSynthesis' + ('speechSynthesis' in window ? '' : ' absent'));
  if ('speechSynthesis' in window) {
    const fr = frenchVoices();
    add(fr.length > 0, 'Voix françaises trouvées', fr.length + ' (' + fr.slice(0, 3).map((v) => v.name).join(', ') + ')');
  }

  const sr = await recognitionTest;
  add(/^voix reconnue/.test(sr), 'Reconnaissance vocale (dis « bonjour »)', sr);
  const mic = await diagMic();
  add(/^ok/.test(mic), 'Permission micro du site', mic);
  add(null, 'Lecture à voix haute', 'Ferme ce diagnostic puis appuie sur « Tester la voix » dans les réglages : ce bouton lance la voix directement pendant ton toucher.');

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
      $('connect-qr').classList.remove('hidden');
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
      $('connect-qr').classList.add('hidden');
      $('connect-url').textContent = j.pending
        ? 'Préparation du lien sécurisé pour le téléphone…'
        : 'Le lien HTTPS du téléphone est indisponible. Relance Lumi sur le PC, puis réessaie.';
      if (j.pending) setTimeout(() => {
        if (!$('connect-panel').classList.contains('hidden')) loadConnectQr();
      }, 2000);
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

$('btn-new').addEventListener('click', (e) => {
  if (!currentProfile || archiving || chatLoading || activeChat) return;
  // Confirme en 2 taps : archiver efface la leçon en cours, on ne déclenche pas ça par accident.
  const btn = (e && e.currentTarget) || $('btn-new');
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    const old = btn.innerHTML;
    btn.textContent = 'Terminer ?';
    setTimeout(() => { btn.classList.remove('armed'); btn.innerHTML = old; }, 4000);
    return;
  }
  btn.classList.remove('armed');
  btn.innerHTML = '<span class="button-icon" aria-hidden="true">🆕</span><span class="button-label">Leçon</span>';
  archiveCurrentLesson();
});
async function archiveCurrentLesson() {
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
}

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

// Niveau par age (comme le serveur) : pour afficher le programme quand la classe
// n'a pas ete choisie dans le formulaire de profil.
const AGE_LEVEL_FRONT = { 6: 'CP', 7: 'CE1', 8: 'CE2', 9: 'CM1', 10: 'CM2', 11: '6e', 12: '5e', 13: '4e', 14: '3e' };

async function renderParentArea() {
  const box = $('parent-content');
  box.innerHTML = '<p class="hint">Chargement… ⏳</p>';
  let list = [];
  try { list = (await (await fetch('/api/profiles')).json()) || []; } catch {}
  // Programme officiel (CP -> 3e) : servira pour afficher les notions par classe
  let curriculum = null;
  try { curriculum = await (await fetch('/api/curriculum')).json(); } catch {}
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
      <h3>${kid.photo ? `<img src="${escapeHtml(kid.photo)}" class="pill-photo" alt="">` : ''} ${escapeHtml(kid.name)} <span class="badge">${escapeHtml(kid.level || (kid.age + ' ans'))}</span></h3>
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
    // Programme officiel du niveau de l'enfant : repliable, liste de notions par matiere
    const lvl = kid.level || (AGE_LEVEL_FRONT[kid.age] || '');
    const prog = curriculum && lvl && curriculum[lvl];
    if (prog) {
      const matieres = Object.keys(prog).length;
      html += `<details class="prog-details"><summary>📚 Programme officiel — ${escapeHtml(lvl)} (${matieres} matière${matieres > 1 ? 's' : ''})</summary>` +
        Object.entries(prog).map(([mat, arr]) => `<p class="prog-mat"><strong>${escapeHtml(mat)}</strong> — ${escapeHtml(arr.join(' · '))}</p>`).join('') + '</details>';
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

// ---------- Navigation réservée à la session administrateur ----------
let adminNavigationGeneration = 0;
async function refreshAdminNavigation() {
  const generation = ++adminNavigationGeneration;
  const links = document.querySelectorAll('[data-admin-link]');
  // Masquer immédiatement : aucun droit déduit d'un profil ou du stockage local.
  links.forEach(link => link.classList.add('hidden'));
  try {
    const response = await fetch('/api/admin/session', { cache: 'no-store' });
    if (!response.ok) return;
    const session = await response.json();
    if (generation !== adminNavigationGeneration) return;
    links.forEach(link => link.classList.toggle('hidden', session.open !== true));
  } catch { /* En cas de doute, le bouton reste masqué. */ }
}
window.addEventListener('focus', refreshAdminNavigation);
window.addEventListener('pageshow', refreshAdminNavigation);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAdminNavigation(); });
refreshAdminNavigation();

// ---------- Démarrage ----------
function configureAdminTest(enabled) {
  if (adminTestMode && !enabled) { $('pf-name').value = ''; $('pf-age').value = ''; }
  adminTestMode = enabled;
  $('admin-test-note').classList.toggle('hidden', !enabled);
  $('pf-age').max = enabled ? '110' : '18';
  $('pf-name').placeholder = enabled ? 'Ton nom (ex. Admin)' : "Prénom de l'enfant";
  $('profile-form-title').textContent = enabled ? 'Ajouter un profil d’essai' : 'Ajouter un enfant';
  if (enabled && !$('pf-name').value) $('pf-name').value = 'Admin';
  $('profile-hint').textContent = enabled ? 'Tes essais sont séparés des enfants et des familles. Saisis ton âge réel.' : 'Tu peux ajouter plusieurs enfants. Depuis une conversation, touche « Profils » pour retrouver cette liste et ajouter un enfant.';
  $('btn-parent').classList.toggle('hidden', enabled);
  if (enabled) $('pf-age').focus();
}
// Si l'app est protégée par un code d'accès (mode hébergé), on l'affiche
// d'abord ; sinon on ouvre directement l'écran des profils.
function readFamilyInvitation() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has('access')) return '';
  const code = (params.get('access') || '').trim().toUpperCase();
  // Retirer immédiatement le code de l'adresse. Aucun code Admin accepté dans un lien.
  window.history.replaceState(null, '', location.pathname + location.search);
  return /^LUMI-(?:[0-9A-F]{4}-){5}[0-9A-F]{4}$/.test(code) ? code : '';
}
async function initApp() {
  const invitation = readFamilyInvitation();
  if (invitation) {
    setLiveMic(false); stopSpeech();
    $('screen-profile').classList.add('hidden'); $('screen-chat').classList.add('hidden');
    $('screen-gate').classList.remove('hidden'); $('gate-code').value = invitation;
    $('gate-consent').checked = false;
    $('gate-error').textContent = 'Code rempli depuis ton invitation. Confirme être le parent, puis touche « Entrer ».';
    $('gate-consent').focus(); return;
  }
  try {
    const g = await (await fetch('/api/gate')).json();
    if (g.locked && !g.open) {
      $('screen-gate').classList.remove('hidden');
      $('gate-code').focus();
      return;
    }
  } catch {
    $('screen-gate').classList.remove('hidden');
    $('gate-error').textContent = 'Lumi ne peut pas vérifier ton accès. Vérifie la connexion puis réessaie.'; return;
  }
  try { const me = await (await fetch('/api/auth/me')).json(); configureAdminTest(me.adminTest === true); }
  catch { configureAdminTest(false); }
  $('screen-profile').classList.remove('hidden');
  fetchProfiles().then(() => renderProfiles());
}
function enterGate() {
  const code = $('gate-code').value.trim();
  if (!code) return;
  if (code.toUpperCase().startsWith('LUMI-') && !$('gate-consent').checked) {
    $('gate-error').textContent = 'Confirme être le parent ou responsable légal en cochant la case.';
    $('gate-consent').focus();
    return;
  }
  fetch('/api/unlock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, consent: $('gate-consent').checked })
  }).then(async r => {
    refreshAdminNavigation();
    if (r.ok) {
      profilesCache = []; profileFetchGeneration++;
      const result = await r.json();
      if (result.admin === true) { $('gate-code').value = ''; location.href = '/admin.html'; return; }
      configureAdminTest(result.admin === true);
      $('screen-gate').classList.add('hidden');
      $('screen-profile').classList.remove('hidden');
      fetchProfiles().then(() => renderProfiles());
    } else {
      const j = await r.json().catch(() => ({}));
      $('gate-error').textContent = j.error || 'Code incorrect 🙂';
    }
  }).catch(() => { $('gate-error').textContent = 'Impossible de contacter Lumi.'; });
}
$('btn-gate-enter').addEventListener('click', enterGate);
$('gate-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') enterGate(); });
initApp();
window.addEventListener('hashchange', () => { if (new URLSearchParams(location.hash.slice(1)).has('access')) initApp(); });
if ('speechSynthesis' in window) speechSynthesis.getVoices();

// ---------- Installation sur l'écran d'accueil ----------
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
});
function showInstall() {
  $('settings-modal').classList.add('hidden');
  $('install-modal').classList.remove('hidden');
  const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  $('install-intro').textContent = installed ? 'Lumi est déjà ouverte comme une application.' : 'Garde Lumi à portée de main depuis son icône.';
  $('btn-install-native').classList.toggle('hidden', installed || !installPrompt);
  $('install-steps').innerHTML = installed ? '<li>Ouvre Lumi depuis son icône sur l’écran d’accueil.</li>' : isIOS
    ? '<li>Ouvre Lumi dans <strong>Safari</strong>.</li><li>Appuie sur <strong>Partager</strong> (le carré avec une flèche vers le haut).</li><li>Choisis <strong>Sur l’écran d’accueil</strong>, puis <strong>Ajouter</strong>. Garde « Ouvrir comme app web » activé si cette option apparaît.</li>'
    : '<li>Ouvre Lumi dans <strong>Chrome</strong> ou <strong>Edge</strong>.</li><li>Dans le menu du navigateur, choisis <strong>Installer l’application</strong> ou <strong>Ajouter à l’écran d’accueil</strong>.</li><li>Confirme l’installation, puis ouvre l’icône <strong>Lumi</strong>.</li>';
}
$('btn-install').addEventListener('click', showInstall);
$('btn-install-settings').addEventListener('click', showInstall);
$('btn-install-close').addEventListener('click', () => $('install-modal').classList.add('hidden'));
$('btn-install-native').addEventListener('click', async () => {
  const prompt = installPrompt;
  if (!prompt) return;
  installPrompt = null;
  await prompt.prompt();
  const result = await prompt.userChoice;
  $('install-intro').textContent = result.outcome === 'accepted' ? 'Installation demandée. Ouvre Lumi depuis son icône.' : 'Tu peux installer Lumi plus tard depuis ce bouton.';
  $('btn-install-native').classList.add('hidden');
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('btn-install').textContent = '📲 Lumi est installée';
});

// ---------- Test de sortie audio, indépendant des voix du téléphone ----------
let soundCheck = null;
$('btn-test-sound').addEventListener('click', () => {
  setLiveMic(false);
  stopSpeech();
  if (!soundCheck) soundCheck = new Audio('/sound-check.wav');
  soundCheck.pause();
  soundCheck.currentTime = 0;
  soundCheck.volume = 1;
  $('voice-feedback').textContent = 'Écoute la petite mélodie. Aucun son ? Vérifie le volume et la sortie Bluetooth.';
  soundCheck.play().catch(() => {
    $('voice-feedback').textContent = 'Le navigateur a bloqué le son. Rouvre Lumi dans Safari ou Chrome, puis retouche « Tester le son ».';
  });
});


// ---------- Partager Lumi et demander un accès ----------
document.querySelectorAll('[data-copy-lumi-link]').forEach(button => {
  button.addEventListener('click', async () => {
    const url = new URL('/', location.href).href;
    try { await navigator.clipboard.writeText(url); toast('Lien copié. Colle-le dans ton message ou dans la barre d’adresse.'); }
    catch {
      let field = button.nextElementSibling;
      if (!field || !field.matches('[data-lumi-link]')) {
        field = document.createElement('input'); field.readOnly = true; field.dataset.lumiLink = '';
        field.className = 'lumi-link-field'; field.setAttribute('aria-label', 'Lien de Lumi à copier');
        field.addEventListener('click', () => { field.select(); field.setSelectionRange(0,field.value.length); });
        button.after(field);
      }
      field.value = url; field.focus(); field.select(); field.setSelectionRange(0,url.length);
      toast('Lien sélectionné. Choisis « Copier ».');
    }
  });
});
async function shareLumi() {
  const url = new URL('/', location.href).href;
  const text = 'Découvre Lumi pour les révisions. Ouvre le lien et choisis « Demander un accès » : le responsable pourra autoriser ta famille.';
  try {
    if (navigator.share) { await navigator.share({ title: 'Lumi — révisions en famille', text, url }); return; }
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text + '\n' + url); toast('Lien copié. Colle-le dans ton message.'); return; }
    toast('Copie ce lien dans ton message : ' + url, 12000);
  } catch (e) { if (e.name !== 'AbortError') toast('Partage impossible. Copie ce lien : ' + url, 12000); }
}
$('btn-share-app').addEventListener('click', shareLumi);
$('btn-share-gate').addEventListener('click', shareLumi);
$('btn-request-access').addEventListener('click', () => {
  $('request-modal').classList.remove('hidden'); $('request-name').focus();
});
$('btn-request-close').addEventListener('click', () => $('request-modal').classList.add('hidden'));
$('request-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('btn-request-send');
  if (button.disabled) return;
  button.disabled = true; $('request-feedback').textContent = 'Envoi de la demande…';
  try {
    const r = await fetch('/api/access-request', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('request-name').value, phone: $('request-phone').value, email: $('request-email').value, consent: $('request-consent').checked }) });
    const j = await r.json();
    $('request-feedback').textContent = j.message || j.error || 'Impossible d’enregistrer la demande.';
    if (r.ok) $('request-form').reset();
  } catch { $('request-feedback').textContent = 'Connexion impossible. Réessaie dans un moment.'; }
  finally { button.disabled = false; }
});
$('btn-switch-access').textContent = 'Déconnecter cet appareil';
$('btn-switch-access').addEventListener('click', async () => {
  try {
    const r = await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok && r.status !== 401) throw new Error();
    refreshAdminNavigation();
    cancelChat(); currentProfile = null; history = []; profilesCache = []; profileFetchGeneration++;
    configureAdminTest(false);
    lastSpeechText = ''; voiceAudioText = '';
    if (voiceAudioUrl) { URL.revokeObjectURL(voiceAudioUrl); voiceAudioUrl = null; }
    if (voiceAudio) voiceAudio.src = '/audio-ready.wav';
    $('screen-profile').classList.add('hidden'); $('screen-chat').classList.add('hidden');
    $('screen-gate').classList.remove('hidden'); $('gate-code').value = ''; $('gate-code').focus();
    $('gate-error').textContent = 'Appareil déconnecté. Tu peux entrer un autre code famille.';
  } catch { toast('Déconnexion impossible. Réessaie.'); }
});
