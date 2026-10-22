'use strict';
// ===================== Savika Profs — logique de l'interface =====================
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNote = (v) => String(v == null ? '' : v).replace('.', ',');

let toastTimer = null;
function toast(msg, ms = 4000) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok) {
    const err = new Error(j.error || 'Erreur ' + r.status);
    err.status = r.status;
    throw err;
  }
  return j;
}

// ---------- Authentification ----------
async function refreshAuth() {
  try {
    const me = await api('/api/auth/me');
    const email = me && me.account && me.account.email;
    if (email) {
      $('auth-wrap').classList.add('hidden');
      $('app').classList.remove('hidden');
      $('user-email').textContent = email;
      loadHistory();
      pileResume(email);
      return;
    }
  } catch {}
  $('auth-wrap').classList.remove('hidden');
  $('app').classList.add('hidden');
}

async function doAuth(kind) {
  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;
  const msg = $('auth-msg');
  if (!email || !password) { msg.textContent = 'Renseigne ton e-mail et ton mot de passe.'; return; }
  if (kind === 'register' && !$('auth-consent').checked) { msg.textContent = 'Coche la case d’acceptation pour créer le compte.'; return; }
  msg.textContent = kind === 'register' ? 'Création du compte…' : 'Connexion…';
  try {
    await api(kind === 'register' ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      body: kind === 'register' ? { email, password, consent: true } : { email, password }
    });
    await refreshAuth();
    toast(kind === 'register' ? 'Compte créé — bienvenue !' : 'Connecté.');
  } catch (e) {
    msg.textContent = '⚠️ ' + e.message;
  }
}

$('btn-login').addEventListener('click', () => doAuth('login'));
$('btn-register').addEventListener('click', () => doAuth('register'));
$('auth-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuth('login'); });
$('btn-logout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch {}
  try { localStorage.removeItem('savika_pile_v1'); } catch {}
  pileStopPolling();
  await refreshAuth();
});

// ---------- Navigation ----------
document.querySelectorAll('.nav-btn').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((x) => x.classList.toggle('active', x === b));
    ['correct', 'lesson', 'pile', 'history'].forEach((v) => $('view-' + v).classList.toggle('hidden', v !== b.dataset.view));
    if (b.dataset.view === 'history') loadHistory();
  });
});

// ---------- Notions (suggestions) ----------
let notionsTimer = null;
async function updateNotions() {
  const niveau = $('l-niveau').value;
  const q = $('l-topic').value.trim();
  if (!niveau) return;
  clearTimeout(notionsTimer);
  notionsTimer = setTimeout(async () => {
    try {
      const j = await api('/api/profs/notions?niveau=' + encodeURIComponent(niveau) + '&q=' + encodeURIComponent(q));
      const dl = $('notions');
      dl.innerHTML = '';
      (j.notions || []).forEach((n) => {
        const o = document.createElement('option');
        o.value = n.notion;
        o.label = n.matiere;
        dl.appendChild(o);
      });
    } catch {}
  }, 250);
}
$('l-niveau').addEventListener('change', updateNotions);
$('l-topic').addEventListener('input', updateNotions);

// ---------- Correction de copie ----------
let currentImage = null;   // base64 sans préfixe
let lastCorrection = null;
let lastPhoto = null;

$('file').addEventListener('change', async () => {
  const f = $('file').files && $('file').files[0];
  if (!f) return;
  if (!/^image\//.test(f.type)) { toast('Choisis une image (JPEG ou PNG).'); return; }
  if (f.size > 8 * 1024 * 1024) { toast('Photo trop lourde (8 Mo max). Reprends-la moins grande.'); return; }
  const dataUrl = await new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.readAsDataURL(f);
  });
  currentImage = dataUrl.split(',')[1] || null;
  $('preview').src = dataUrl;
  $('preview').classList.remove('hidden');
  $('drop-ico').classList.add('hidden');
  $('drop-txt').innerHTML = '<b>Photo prête</b> — touche pour remplacer';
});
$('drop').addEventListener('dragover', (e) => { e.preventDefault(); $('drop').classList.add('over'); });
$('drop').addEventListener('dragleave', () => $('drop').classList.remove('over'));
$('drop').addEventListener('drop', (e) => {
  e.preventDefault();
  $('drop').classList.remove('over');
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) {
    const dt = new DataTransfer();
    dt.items.add(f);
    $('file').files = dt.files;
    $('file').dispatchEvent(new Event('change'));
  }
});

$('btn-correct').addEventListener('click', async () => {
  const msg = $('c-msg');
  if (!currentImage) { msg.textContent = 'Ajoute une photo de la copie.'; return; }
  const niveau = $('c-niveau').value;
  const matiere = $('c-matiere').value.trim();
  if (!niveau || !matiere) { msg.textContent = 'Précise le niveau et la matière.'; return; }
  const btn = $('btn-correct');
  btn.disabled = true;
  msg.textContent = 'Lecture de la copie et correction… (10 à 30 s)';
  try {
    const j = await api('/api/profs/correct', {
      method: 'POST',
      body: {
        image: currentImage, niveau, matiere,
        bareme: Number($('c-bareme').value) || 20,
        consignes: $('c-consignes').value.trim()
      }
    });
    lastCorrection = { niveau, matiere, correction: j.correction };
    lastPhoto = $('preview').src;
    renderCorrection(j.correction, niveau, matiere, lastPhoto);
    msg.textContent = 'Correction prête — relie-la, ajuste si besoin, puis imprime.';
    loadHistory();
  } catch (e) {
    msg.textContent = '⚠️ ' + e.message;
  } finally {
    btn.disabled = false;
  }
});

$('btn-example').addEventListener('click', async () => {
  const msg = $('c-msg');
  msg.textContent = 'Chargement de l’exemple…';
  try {
    const r = await fetch('/profs/exemple.json');
    if (!r.ok) throw new Error('fichier introuvable');
    const j = await r.json();
    renderCorrection(j.correction, j.niveau, j.matiere, '/profs/exemple-copie.jpg');
    msg.textContent = 'Exemple : copie fictive de Léa (CE1) — correction réellement produite par Savika.';
    $('c-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    msg.textContent = '⚠️ Exemple indisponible : ' + e.message;
  }
});

function renderCorrection(c, niveau, matiere, photoSrc) {
  const p = $('c-result');
  const exos = (c.exercices || []).map((ex) => `
    <div class="exo">
      <div class="exo-head"><h4>${esc(ex.titre)}</h4><span class="pts">${esc(ex.points)} / ${esc(ex.bareme)}</span></div>
      <dl>
        ${ex.enonce ? `<dt>Énoncé</dt><dd>${esc(ex.enonce)}</dd>` : ''}
        <dt>Réponse de l'élève</dt><dd>${esc(ex.reponse_eleve || '—')}</dd>
        <dt>Correction</dt><dd class="corr">${esc(ex.correction)}</dd>
        ${ex.erreurs && ex.erreurs.length ? `<dt>Erreurs</dt><dd class="errs">${esc(ex.erreurs.join(' · '))}</dd>` : ''}
        ${ex.commentaire ? `<dt>Annotation</dt><dd class="comm">${esc(ex.commentaire)}</dd>` : ''}
      </dl>
    </div>`).join('');
  p.innerHTML = `
    <h2>Copie corrigée — ${esc(niveau)} · ${esc(matiere)}</h2>
    ${photoSrc ? `<img class="corr-copy" src="${esc(photoSrc)}" alt="Copie photographiée">` : ''}
    <div class="note-card">
      <div><div class="note-big">${esc(fmtNote(c.total))}/${esc(c.bareme)}</div><div class="note-sub">note proposée</div></div>
      <div class="note-texte">${esc(c.appreciation || '')}</div>
    </div>
    <div class="cols">
      ${c.points_forts && c.points_forts.length ? `<div class="bullets"><h4>✅ Points forts</h4><ul>${c.points_forts.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${c.a_retravailler && c.a_retravailler.length ? `<div class="bullets warn"><h4>🔧 À retravailler</h4><ul>${c.a_retravailler.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    </div>
    <div class="exos">${exos}</div>
    <div class="row" style="margin-top:18px">
      <button class="btn btn-primary" id="btn-print-correction" type="button">🖨️ Imprimer / PDF</button>
    </div>`;
  p.classList.remove('hidden');
  $('btn-print-correction').addEventListener('click', () => printCorrection(c, niveau, matiere));
}

function printCorrection(c, niveau, matiere) {
  const date = new Date().toLocaleDateString('fr-FR');
  $('print-area').innerHTML = `
    <p class="p-kicker">Copie corrigée · Savika Profs</p>
    <h1>${esc(niveau)} — ${esc(matiere)}</h1>
    <p style="color:#6e6e73;font-size:12px;margin:0 0 8px">Évalué le ${date} · Note proposée : <span class="p-note">${esc(fmtNote(c.total))}/${esc(c.bareme)}</span></p>
    <p style="font-style:italic">${esc(c.appreciation || '')}</p>
    ${(c.exercices || []).map((ex) => `
      <h2>${esc(ex.titre)} — ${esc(ex.points)}/${esc(ex.bareme)}</h2>
      <div class="p-exo">
        <div class="p-row">${ex.enonce ? `<b>Énoncé</b><span>${esc(ex.enonce)}</span>` : ''}
          <b>Réponse</b><span>${esc(ex.reponse_eleve || '—')}</span>
          <b>Correction</b><span>${esc(ex.correction)}</span>
          ${ex.erreurs && ex.erreurs.length ? `<b>Erreurs</b><span>${esc(ex.erreurs.join(' · '))}</span>` : ''}
          ${ex.commentaire ? `<b>Annotation</b><span><i>${esc(ex.commentaire)}</i></span>` : ''}
        </div>
      </div>`).join('')}
    ${c.points_forts && c.points_forts.length ? `<h2>Points forts</h2><ul>${c.points_forts.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${c.a_retravailler && c.a_retravailler.length ? `<h2>À retravailler</h2><ul>${c.a_retravailler.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div class="p-foot"><span>Correction du ${date}</span><span>Savika Profs · lumirevision.com/profs</span></div>`;
  window.print();
}

// ---------- Idées de cours ----------
let lastLesson = null;
$('btn-lesson').addEventListener('click', async () => {
  const msg = $('l-msg');
  const niveau = $('l-niveau').value;
  const matiere = $('l-matiere').value.trim();
  const topic = $('l-topic').value.trim();
  if (!niveau || !matiere || !topic) { msg.textContent = 'Précise le niveau, la matière et le sujet.'; return; }
  const btn = $('btn-lesson');
  btn.disabled = true;
  msg.textContent = 'Conception de la séance… (10 à 30 s)';
  try {
    const j = await api('/api/profs/lesson', {
      method: 'POST',
      body: { niveau, matiere, topic, duree: Number($('l-duree').value) || 55, objectif: $('l-objectif').value.trim() }
    });
    lastLesson = { niveau, matiere, lesson: j.lesson };
    renderLesson(j.lesson, niveau, matiere);
    msg.textContent = 'Fiche prête — tu peux l’imprimer ou l’adapter.';
    loadHistory();
  } catch (e) {
    msg.textContent = '⚠️ ' + e.message;
  } finally {
    btn.disabled = false;
  }
});

function renderLesson(l, niveau, matiere) {
  const p = $('l-result');
  p.innerHTML = `
    <div class="lesson-head">
      <h3>${esc(l.titre)}</h3>
      <div class="lesson-meta">${esc(niveau)} · ${esc(matiere)} · ${esc(l.duree_min)} minutes</div>
    </div>
    ${l.objectifs.length ? `<div class="lesson-block"><h4>Objectifs</h4><ul class="simple-list">${l.objectifs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${l.prerequis.length ? `<div class="lesson-block"><h4>Prérequis</h4><ul class="simple-list">${l.prerequis.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${l.materiel.length ? `<div class="lesson-block"><h4>Matériel</h4><p>${esc(l.materiel.join(' · '))}</p></div>` : ''}
    <div class="lesson-block"><h4>Déroulé</h4>
      ${l.phases.map((ph) => `<div class="phase"><div class="duree">${esc(ph.duree_min)}′</div><div><strong>${esc(ph.titre)}</strong><p style="margin:6px 0 0;font-size:.94rem;line-height:1.5">${esc(ph.contenu)}</p></div></div>`).join('')}
    </div>
    ${l.exercices.length ? `<div class="lesson-block"><h4>Exercices</h4>${l.exercices.map((ex) => `<div class="exo"><dl><dt>Consigne</dt><dd>${esc(ex.consigne)}</dd>${ex.corrige ? `<dt>Corrigé</dt><dd class="corr">${esc(ex.corrige)}</dd>` : ''}</dl></div>`).join('')}</div>` : ''}
    ${l.evaluation.questions.length ? `<div class="lesson-block"><h4>Évaluation</h4><ul class="simple-list">${l.evaluation.questions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${l.differenciation ? `<div class="lesson-block"><h4>Différenciation</h4><p>${esc(l.differenciation)}</p></div>` : ''}
    <div class="row" style="margin-top:12px">
      <button class="btn btn-primary" id="btn-print-lesson" type="button">🖨️ Imprimer / PDF</button>
    </div>`;
  p.classList.remove('hidden');
  $('btn-print-lesson').addEventListener('click', () => printLesson(l, niveau, matiere));
}

function printLesson(l, niveau, matiere) {
  const date = new Date().toLocaleDateString('fr-FR');
  $('print-area').innerHTML = `
    <p class="p-kicker">Fiche de cours · Savika Profs</p>
    <h1>${esc(l.titre)}</h1>
    <p style="color:#6e6e73;font-size:12px;margin:0 0 8px">${esc(niveau)} · ${esc(matiere)} · ${esc(l.duree_min)} min · préparée le ${date}</p>
    <p class="p-blank">Classe : ______________________ · Date : ______________________</p>
    ${l.objectifs.length ? `<h2>Objectifs</h2><ul>${l.objectifs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${l.prerequis.length ? `<h2>Prérequis</h2><ul>${l.prerequis.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${l.materiel.length ? `<h2>Matériel</h2><p>${esc(l.materiel.join(' · '))}</p>` : ''}
    <h2>Déroulé</h2>${l.phases.map((ph) => `<div class="p-exo"><div class="p-row"><b>${esc(ph.duree_min)} min</b><span><b>${esc(ph.titre)}</b><br>${esc(ph.contenu)}</span></div></div>`).join('')}
    ${l.exercices.length ? `<h2>Exercices</h2>${l.exercices.map((ex) => `<div class="p-exo"><div class="p-row"><b>Consigne</b><span>${esc(ex.consigne)}</span>${ex.corrige ? `<b>Corrigé</b><span>${esc(ex.corrige)}</span>` : ''}</div></div>`).join('')}` : ''}
    ${l.evaluation.questions.length ? `<h2>Évaluation</h2><ul>${l.evaluation.questions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${l.differenciation ? `<h2>Différenciation</h2><p>${esc(l.differenciation)}</p>` : ''}
    <div class="p-foot"><span>Fiche préparée le ${date}</span><span>Savika Profs · lumirevision.com/profs</span></div>`; 
  window.print();
}

// ---------- Historique ----------
async function loadHistory() {
  try {
    const j = await api('/api/profs/history');
    const uc = $('hist-corrections');
    const ul = $('hist-lessons');
    uc.innerHTML = (j.corrections || []).length
      ? j.corrections.map((c) => `<li><button type="button" data-kind="c" data-id="${esc(c.id)}">${esc(c.niveau || '')} · ${esc(c.matiere || '')} — <b>${esc(fmtNote(c.total))}/${esc(c.bareme)}</b><span class="date">${new Date(c.created).toLocaleString('fr-FR')}</span></button></li>`).join('')
      : '<li class="hint">Aucune copie corrigée pour le moment.</li>';
    ul.innerHTML = (j.lessons || []).length
      ? j.lessons.map((l) => `<li><button type="button" data-kind="l" data-id="${esc(l.id)}">${esc(l.titre || l.topic)} — ${esc(l.niveau || '')} · ${esc(l.matiere || '')}<span class="date">${new Date(l.created).toLocaleString('fr-FR')}</span></button></li>`).join('')
      : '<li class="hint">Aucune fiche de cours pour le moment.</li>';
    document.querySelectorAll('#hist-corrections button, #hist-lessons button').forEach((b) => {
      if (!b.dataset.id) return;
      b.addEventListener('click', () => openHistoryItem(b.dataset.id, b.dataset.kind));
    });
  } catch {}
}

async function openHistoryItem(id, kind) {
  try {
    const j = await api('/api/profs/item?id=' + encodeURIComponent(id));
    if (kind === 'c') {
      renderCorrection(j.data, j.niveau || '', j.matiere || '');
      document.querySelector('.nav-btn[data-view="correct"]').click();
    } else {
      renderLesson(j.data, j.niveau || '', j.matiere || '');
      document.querySelector('.nav-btn[data-view="lesson"]').click();
    }
  } catch (e) { toast('Ouverture impossible : ' + e.message); }
}


// ---------- Mode Pile : lot temporaire, corrections en série ----------
let pile = null;
let pileThumbs = {};
let pileTimer = null;
let pileReplaceN = null;
let pileLastDetail = null;

function pileStopPolling() { clearInterval(pileTimer); pileTimer = null; }

function pileStartPolling() {
  pileStopPolling();
  pileTimer = setInterval(async () => {
    if (!pile) { pileStopPolling(); return; }
    try {
      const st = await api('/api/profs/batch/status?id=' + encodeURIComponent(pile.id));
      pile = st;
      renderPile();
      if (!st.running) pileStopPolling();
    } catch (e) {
      if (e.status === 404) pileLost();
    }
  }, 1800);
}

function pileLost() {
  pileStopPolling();
  pile = null; pileThumbs = {}; pileReplaceN = null;
  try { localStorage.removeItem('savika_pile_v1'); } catch {}
  $('pile-live').classList.add('hidden');
  $('pile-detail').classList.add('hidden');
  $('pile-setup').classList.remove('hidden');
  toast('La pile a été fermée ou a expiré — tu peux en recommencer une.');
}

function pileCompress(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        let w = img.naturalWidth, h = img.naturalHeight;
        const max = 1400;
        const sc = Math.min(1, max / Math.max(w, h));
        w = Math.max(1, Math.round(w * sc)); h = Math.max(1, Math.round(h * sc));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, 0, 0, w, h);
        let q = 0.82, data = c.toDataURL('image/jpeg', q);
        while (data.length > 1400000 && q > 0.5) { q -= 0.08; data = c.toDataURL('image/jpeg', q); }
        resolve(data);
      } catch (e) { reject(new Error('Photo illisible.')); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Format de photo non pris en charge.')); };
    img.src = url;
  });
}

$('btn-pile-create').addEventListener('click', async () => {
  const niveau = $('p-niveau').value;
  const matiere = $('p-matiere').value.trim();
  if (!niveau || !matiere) { $('pile-msg').textContent = 'Précise le niveau et la matière de la pile.'; return; }
  const btn = $('btn-pile-create');
  btn.disabled = true;
  $('pile-msg').textContent = 'Création de la pile…';
  try {
    pile = await api('/api/profs/batch/create', {
      method: 'POST',
      body: { niveau, matiere, bareme: Number($('p-bareme').value) || 20, consignes: $('p-consignes').value.trim() }
    });
    pileThumbs = {}; pileReplaceN = null; pileLastDetail = null;
    try {
      const email = $('user-email').textContent || '';
      localStorage.setItem('savika_pile_v1', JSON.stringify({ email, id: pile.id }));
    } catch {}
    $('pile-msg').textContent = '';
    $('pile-setup').classList.add('hidden');
    $('pile-detail').classList.add('hidden');
    $('pile-live').classList.remove('hidden');
    renderPile();
  } catch (e) {
    $('pile-msg').textContent = '⚠️ ' + e.message;
  } finally { btn.disabled = false; }
});

async function pileResume(email) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('savika_pile_v1') || 'null'); } catch {}
  if (!saved || !saved.id || saved.email !== email) return;
  try {
    const st = await api('/api/profs/batch/status?id=' + encodeURIComponent(saved.id));
    pile = st; pileThumbs = {};
    $('pile-setup').classList.add('hidden');
    $('pile-live').classList.remove('hidden');
    renderPile();
    if (st.running) pileStartPolling();
  } catch {
    try { localStorage.removeItem('savika_pile_v1'); } catch {}
  }
}

$('pile-file').addEventListener('change', async () => {
  const f = $('pile-file').files && $('pile-file').files[0];
  $('pile-file').value = '';
  if (!f || !pile) return;
  try {
    const dataUrl = await pileCompress(f);
    const body = { id: pile.id, image: dataUrl };
    if (pileReplaceN) body.n = pileReplaceN;
    const st = await api('/api/profs/batch/item', { method: 'POST', body });
    const n = pileReplaceN || st.total;
    pileThumbs[n] = dataUrl;
    pileReplaceN = null;
    pile = st;
    renderPile();
    pileStartPolling();
  } catch (e) {
    pileReplaceN = null;
    toast('⚠️ ' + e.message);
  }
});

function pilePill(it) {
  if (it.state === 'done') return '<span class="pill pill-ok">Corrigée</span>';
  if (it.state === 'running') return '<span class="pill pill-run">Correction…</span>';
  if (it.state === 'error') return '<span class="pill pill-err">À reprendre</span>';
  return '<span class="pill pill-wait">En attente</span>';
}

function renderPile() {
  if (!pile) return;
  $('pile-title').textContent = 'Pile ' + pile.niveau + ' · ' + pile.matiere;
  const mots = (n, s) => n + ' ' + s + (n > 1 ? 's' : '');
  $('pile-sub').textContent = mots(pile.total, 'copie') + ' · barème ' + fmtNote(pile.bareme) + ' points · notes reportées : ' + pile.checked + '/' + pile.done;
  const avance = pile.done + pile.errors;
  const pct = pile.total ? Math.round((avance / pile.total) * 100) : 0;
  $('pile-bar').style.width = pct + '%';
  $('pile-progress').textContent = pile.running
    ? 'Correction en cours… ' + avance + '/' + pile.total
    : (pile.total ? pile.done + ' corrigée' + (pile.done > 1 ? 's' : '') + ' · ' + pile.errors + ' à reprendre' : 'Aucune copie pour le moment');
  const q = $('pile-quota');
  if (pile.quotaStop) { q.textContent = '⚠️ ' + pile.quotaStop + ' Les copies restantes n’ont pas été corrigées.'; q.classList.remove('hidden'); }
  else q.classList.add('hidden');
  const items = (pile.items || []).map((it) => {
    if (!it) return '';
    const n = it.n;
    const thumb = pileThumbs[n] ? `<img src="${pileThumbs[n]}" alt="Copie ${n}">` : '<span class="pile-ph">📄</span>';
    return `
      <div class="pile-card">
        <div class="pile-thumb">${thumb}<span class="pile-num">${n}</span>${pilePill(it)}</div>
        <div class="pile-body">
          ${it.state === 'done' ? `<div class="pile-note">${esc(fmtNote(it.total))}<span>/${esc(it.bareme)}</span></div>` : ''}
          ${it.state === 'error' ? `<p class="pile-err">${esc(it.error || 'Correction impossible.')}</p>` : ''}
          <div class="pile-card-actions">
            ${it.state === 'done' ? `<button class="btn btn-sm" type="button" data-act="detail" data-n="${n}">Détail</button>` : ''}
            ${it.state === 'error' ? `<button class="btn btn-sm" type="button" data-act="retry">Relancer</button>` : ''}
            ${it.state !== 'running' ? `<button class="btn btn-sm btn-ghost" type="button" data-act="replace" data-n="${n}">Reprendre</button>` : ''}
          </div>
          ${it.state === 'done' ? `<label class="check"><input type="checkbox" data-act="checked" data-n="${n}" ${it.checked ? 'checked' : ''}> Note reportée sur la copie</label>` : ''}
        </div>
      </div>`;
  }).join('');
  $('pile-items').innerHTML = items || '<p class="hint">Photographie la première copie.</p>';
}

$('pile-items').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const n = Number(b.dataset.n || 0);
  if (b.dataset.act === 'detail') openPileDetail(n);
  if (b.dataset.act === 'replace') { pileReplaceN = n; $('pile-file').click(); }
  if (b.dataset.act === 'retry') retryPile();
});

$('pile-items').addEventListener('change', async (e) => {
  const c = e.target.closest('input[data-act="checked"]');
  if (!c || !pile) return;
  try {
    pile = await api('/api/profs/batch/checked', { method: 'POST', body: { id: pile.id, n: Number(c.dataset.n), checked: c.checked } });
    renderPile();
  } catch (err) { toast('⚠️ ' + err.message); }
});

async function retryPile() {
  if (!pile) return;
  try {
    pile = await api('/api/profs/batch/run', { method: 'POST', body: { id: pile.id } });
    renderPile();
    pileStartPolling();
  } catch (e) { toast('⚠️ ' + e.message); }
}

async function openPileDetail(n) {
  if (!pile) return;
  try {
    const it = await api('/api/profs/batch/item?id=' + encodeURIComponent(pile.id) + '&n=' + n);
    const d = $('pile-detail');
    d.classList.remove('hidden');
    if (it.state !== 'done' || !it.correction) {
      d.innerHTML = `<div class="detail-top"><h3>Copie ${n}</h3><button class="btn btn-sm" type="button" data-act="close-detail">Fermer</button></div>
        <p class="hint">${esc(it.error || 'Correction en cours…')}</p>`;
    } else {
      const c = it.correction;
      pileLastDetail = { n, c };
      const exos = (c.exercices || []).map((ex) => `
        <div class="exo">
          <div class="exo-head"><h4>${esc(ex.titre)}</h4><span class="pts">${esc(ex.points)} / ${esc(ex.bareme)}</span></div>
          <dl>
            <dt>Réponse de l'élève</dt><dd>${esc(ex.reponse_eleve || '—')}</dd>
            <dt>Correction</dt><dd class="corr">${esc(ex.correction)}</dd>
            ${ex.erreurs && ex.erreurs.length ? `<dt>Erreurs</dt><dd class="errs">${esc(ex.erreurs.join(' · '))}</dd>` : ''}
            ${ex.commentaire ? `<dt>Annotation</dt><dd class="comm">${esc(ex.commentaire)}</dd>` : ''}
          </dl>
        </div>`).join('');
      d.innerHTML = `
        <div class="detail-top">
          <h3>Copie ${n} — ${esc(fmtNote(c.total))}/${esc(c.bareme)}</h3>
          <div class="row">
            <button class="btn btn-sm btn-primary" type="button" data-act="print-detail">🖨️ Imprimer cette copie</button>
            <button class="btn btn-sm" type="button" data-act="close-detail">Fermer</button>
          </div>
        </div>
        ${pileThumbs[n] ? `<img class="corr-copy" src="${pileThumbs[n]}" alt="Copie ${n}">` : ''}
        <div class="note-card">
          <div><div class="note-big">${esc(fmtNote(c.total))}/${esc(c.bareme)}</div><div class="note-sub">note proposée</div></div>
          <div class="note-texte">${esc(c.appreciation || '')}</div>
        </div>
        ${c.points_forts && c.points_forts.length ? `<div class="bullets"><h4>✅ Points forts</h4><ul>${c.points_forts.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
        ${c.a_retravailler && c.a_retravailler.length ? `<div class="bullets warn" style="margin-top:10px"><h4>🔧 À retravailler</h4><ul>${c.a_retravailler.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
        <div class="exos">${exos}</div>`;
    }
    d.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { toast('⚠️ ' + e.message); }
}

$('pile-detail').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  if (b.dataset.act === 'close-detail') $('pile-detail').classList.add('hidden');
  if (b.dataset.act === 'print-detail' && pileLastDetail && pile) {
    printCorrection(pileLastDetail.c, pile.niveau, pile.matiere);
  }
});

$('btn-pile-recap').addEventListener('click', () => {
  if (!pile || !pile.total) { toast('Aucune copie dans la pile.'); return; }
  printPileRecap();
});

$('btn-pile-finish').addEventListener('click', async () => {
  if (!pile) return;
  const rest = Math.max(0, pile.done - pile.checked);
  const warn = rest > 0 ? '\n\n⚠️ ' + rest + ' note(s) ne sont pas encore cochées « reportée » sur les vraies copies.' : '';
  if (!confirm('Terminer la pile ?\nLes photos et toutes les corrections seront supprimées immédiatement.' + warn)) return;
  try { await api('/api/profs/batch/finish', { method: 'POST', body: { id: pile.id } }); }
  catch (e) { toast('⚠️ ' + e.message); }
  pileStopPolling();
  pile = null; pileThumbs = {}; pileReplaceN = null; pileLastDetail = null;
  try { localStorage.removeItem('savika_pile_v1'); } catch {}
  $('pile-live').classList.add('hidden');
  $('pile-detail').classList.add('hidden');
  $('pile-setup').classList.remove('hidden');
  toast('Pile terminée — toutes les données ont été effacées. 🔒');
});

function printPileRecap() {
  const date = new Date().toLocaleDateString('fr-FR');
  const rows = pile.items.map((it) => `
    <tr>
      <td class="num">Copie ${it.n}</td>
      <td class="note">${it.state === 'done' ? esc(fmtNote(it.total)) + '/' + esc(it.bareme) : '—'}</td>
      <td class="chk">${it.checked ? '☑' : '☐'}</td>
      <td class="obs"></td>
    </tr>`).join('');
  $('print-area').innerHTML = `
    <p class="p-kicker">Relevé de correction · Savika Profs</p>
    <h1>${esc(pile.niveau)} — ${esc(pile.matiere)}</h1>
    <p style="color:#6e6e73;font-size:12px;margin:0 0 8px">${pile.total} copie${pile.total > 1 ? 's' : ''} · barème ${esc(fmtNote(pile.bareme))} points · ${date}</p>
    <p class="p-blank">Classe : ______________________ · Devoir : ______________________</p>
    <table>
      <thead><tr><th>Copie</th><th>Note proposée</th><th>Reportée</th><th>Remarque</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="p-privacy">Document de travail du professeur — aucune donnée d'élève conservée. Les photos et corrections de cette pile sont supprimées après utilisation.</p>
    <div class="p-foot"><span>Relevé du ${date}</span><span>Savika Profs · lumirevision.com/profs</span></div>`;
  window.print();
}

// ---------- Démarrage ----------
refreshAuth();
