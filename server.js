import 'dotenv/config';
import express from 'express';
import os from 'os';
import path from 'path';
import { exec, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import fs from 'fs';
import http from 'http';
import https from 'https';
import selfsigned from 'selfsigned';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = (process.env.OLLAMA_BASE_URL || 'https://ollama.com').replace(/\/+$/, '');
const API_KEY = process.env.OLLAMA_API_KEY || '';
const MODEL = process.env.OLLAMA_MODEL || 'glm-5.3-flash:cloud';
// Modele "vision" : utilise uniquement quand l'enfant envoie une photo.
// glm-5.3(-flash) refuse les images ("this model does not support image input"),
// donc on bascule sur un modele multimodal pour les photos.
const VISION_MODEL = process.env.OLLAMA_VISION_MODEL || 'gemma4:31b';
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

// ---------- Stockage des donnees des enfants ----------
// En local : fichier JSON (data/lumi-data.json).
// En ligne (Render etc.) : le disque est efface a chaque mise a jour, on
// peut donc brancher un stockage distant gratuit (Upstash Redis, REST).
// Les donnees sont gardees en memoire et sauvegardees a chaque ecriture.
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'lumi-data.json');

const KV_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch { return {}; }
}
function saveData(data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) { console.error('saveData:', e); }
}

let memData = null;
async function initStore() {
  if (KV_URL && KV_TOKEN) {
    try {
      const r = await fetch(`${KV_URL}/get/lumi-data`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
      const j = await r.json();
      memData = j.result ? JSON.parse(j.result) : {};
      console.log('  ☁️ Données chargées depuis le stockage distant');
    } catch (e) { console.error('KV load:', e.message); memData = {}; }
  } else {
    memData = loadData();
  }
}
function getData() { return memData || {}; }
function setData(data) {
  memData = data;
  if (KV_URL && KV_TOKEN) {
    fetch(`${KV_URL}/set/lumi-data`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify(data)
    }).catch(e => console.error('KV save:', e.message));
  } else {
    saveData(data);
  }
}
function topicLabel(history) {
  const first = (history || []).find(h => h.role === 'user');
  let t = String(first && first.content || '').replace(/\n/g, ' ').trim();
  if (t === '[photo du cahier]' || t.startsWith('[photo')) t = 'Devoir (photo)';
  if (t.length > 40) t = t.slice(0, 40) + '…';
  return t || 'Leçon';
}

// Adresses IP locales (Wi-Fi)
function lanIps() {
  const ips = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

// Certificat HTTPS auto-signé (généré une fois, réutilisé ensuite)
const CERT_FILE = path.join(DATA_DIR, 'cert.pem');
const KEY_FILE = path.join(DATA_DIR, 'key.pem');

async function getOrCreateCert() {
  try {
    if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
      return { cert: fs.readFileSync(CERT_FILE, 'utf8'), key: fs.readFileSync(KEY_FILE, 'utf8') };
    }
  } catch {}
  const attrs = [{ name: 'commonName', value: 'Lumi' }];
  const altNames = [{ type: 2, value: 'localhost' }, ...lanIps().map(ip => ({ type: 7, value: ip }))];
  // IMPORTANT : max 825 jours, sinon l'iPhone (iOS) refuse de continuer
  // ("connexion non securisee" bloque sans option "Continuer").
  const notAfterDate = new Date();
  notAfterDate.setDate(notAfterDate.getDate() + 820);
  const pems = await selfsigned.generate(attrs, { algorithm: 'sha256', notAfterDate, extensions: [{ name: 'subjectAltName', altNames }] });
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CERT_FILE, pems.cert, 'utf8');
    fs.writeFileSync(KEY_FILE, pems.private, 'utf8');
  } catch {}
  return { cert: pems.cert, key: pems.private };
}

const app = express();
app.use(express.json({ limit: '25mb' })); // pour les photos en base64
// KaTeX (rendu des maths) servi depuis node_modules
app.use('/katex', express.static(path.join(__dirname, 'node_modules', 'katex', 'dist')));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') // Safari garde trop le cache
}));

// ---------- Code d'accès (protection de l'app en ligne) ----------
// Si LUMI_ACCESS_CODE est defini, toutes les routes /api demandent ce code
// (entre une fois dans le navigateur, retenu par un cookie 1 an).
const ACCESS_CODE = process.env.LUMI_ACCESS_CODE || '';

function hasAccess(req) {
  const m = String(req.headers.cookie || '').match(/lumi_access=([a-f0-9]{8})/);
  return !!(m && m[1] === accessCookieValue());
}
function accessCookieValue() {
  // valeur derivee du code (pas le code lui-meme)
  let h = 5381;
  for (const c of ACCESS_CODE) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

app.get('/api/gate', (req, res) => {
  res.json({ locked: !!ACCESS_CODE, open: !ACCESS_CODE || hasAccess(req) });
});
app.post('/api/unlock', (req, res) => {
  if (!ACCESS_CODE) return res.json({ ok: true });
  if (String((req.body || {}).code || '').trim() === ACCESS_CODE) {
    res.setHeader('Set-Cookie', `lumi_access=${accessCookieValue()}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Code incorrect.' });
  }
});
app.use('/api', (req, res, next) => {
  if (!ACCESS_CODE || req.path === '/gate' || req.path === '/unlock' || hasAccess(req)) return next();
  res.status(401).json({ error: 'Code d\'accès requis.' });
});

// Certificat telechargeable : l'iPhone doit l'installer dans ses reglages
// pour que Safari autorise le micro et la reconnaissance vocale.
// (Le simple bouton "Continuer" de l'avertissement ne suffit pas pour le micro.)
app.get('/lumi-cert.crt', (req, res) => {
  try {
    const cert = fs.readFileSync(CERT_FILE);
    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
    res.setHeader('Content-Disposition', 'attachment; filename="lumi.crt"');
    res.send(cert);
  } catch (e) {
    res.status(404).send('Certificat indisponible (relance Lumi).');
  }
});

// ---------- Prompt systeme (tuteur) ----------
function buildSystemPrompt(profile = {}) {
  const name = profile.name || 'mon enfant';
  const age = profile.age ?? 10;

  let tone = '';
  if (age <= 6) {
    tone = "Langage tres simple, phrases courtes (max 10 mots), un seul concept a la fois, enormement d'encouragements. Utilise des comparaisons avec les jeux et les animaux.";
  } else if (age <= 10) {
    tone = 'Langage simple et chaleureux, phrases courtes, exemples concrets de la vie quotidienne, encourage beaucoup.';
  } else if (age <= 14) {
    tone = "Langage clair et precis, tu peux approfondir, aide a la methode et a l'organisation.";
  } else {
    tone = 'Langage precis et structure, tu aides a la methode, au raisonnement et a la preparation des examens.';
  }

  return `Tu es "Lumi", un tuteur (maitre/maitresse) bienveillant qui aide ${name} (${age} ans) a faire ses devoirs et a reviser.

REGLES ABSOLUES (a respecter en toutes circonstances) :
1. Tu ne donnes JAMAIS la reponse finale. Tu guides : tu poses des questions, tu donnes des indices, tu fais reflechir. L'enfant doit trouver par lui-meme. S'il est bloque, tu donnes UN indice a la fois, jamais le resultat.
2. ${tone}
3. Tu n'inventes JAMAIS une information. Si tu t'appuies sur une source, tu la cites (titre et lien). Si tu n'es pas sur, tu le dis clairement.
4. Tu encourages et felicites les efforts, meme quand l'enfant se trompe. Une erreur est une etape normale.
5. Tu as un petit caractere joyeux et amusant : sois chaleureux et enthousiaste, utilise de temps en temps un emoji, une pointe d'humour, des "Bravo !", "Super !". Rends l'apprentissage plaisant, sans jamais etre condescendant.
6. Tu reponds toujours en francais.
7. Tu restes TRES bref : maximum 3 phrases courtes par reponse (2, c'est encore mieux). Pas de longues listes a puces (une seule au grand maximum). Va droit au but : pas de salutations repetees, pas de recapitulatif. Si l'enfant demande une explication complete, tu peux aller jusqu'a 5 phrases, jamais plus.
8. Pour les maths, ecris les fractions, puissances et calculs entre $ ... $ (LaTeX) pour un bel affichage. Exemple : $\frac{3}{4}$ ou $3 \times 4$.

Methode par matiere :
- Maths : ne donne pas le resultat, aide a comprendre l'enonce, puis guide etape par etape.
- Francais / lecture : aide a comprendre le sens, fais reformuler.
- Orthographe / grammaire : fais retrouver la regle, ne corrige pas sans explication.
- Histoire / geo / sciences : explique simplement, puis pose des questions pour verifier la comprehension.
- Autres devoirs : guide la methode, ne fais jamais le travail a la place de l'enfant.`;
}

// ---------- Recherche web (sources) ----------
function cleanUrl(u) {
  const m = u.match(/uddg=([^&"']+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  return u;
}
function stripTags(s) { return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }

async function searchWeb(query) {
  const results = [];
  // Wikipedia FR (fiable pour les notions scolaires)
  try {
    const u = `https://fr.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=3&format=json&origin=*`;
    const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    const hits = (j && j.query && j.query.search) || [];
    for (const h of hits) {
      results.push({
        title: h.title,
        snippet: stripTags(h.snippet || '').slice(0, 180),
        url: `https://fr.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
        from: 'Wikipédia'
      });
    }
  } catch {}

  // DuckDuckGo (resultats generaux)
  try {
    const u = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Lumi/0.1)' }, signal: AbortSignal.timeout(7000) });
    const html = await r.text();
    const links = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g)];
    const snippets = [...html.matchAll(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/(?:td|a|span)>/g)].map(m => stripTags(m[1]).slice(0, 180));
    links.slice(0, 5).forEach((m, i) => {
      const raw = m[1];
      if (raw.includes('ad_provider') || raw.includes('y.js') || raw.includes('aclick')) return; // saute les publicités
      const url = cleanUrl(raw);
      const title = stripTags(m[2]);
      if (url && url.startsWith('http') && !url.includes('duckduckgo.com') && !url.includes('amazon.')) {
        results.push({ title, snippet: snippets[i] || '', url, from: 'Web' });
      }
    });
  } catch {}

  const seen = new Set();
  return results.filter(r => { const k = r.url; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8);
}

// ---------- Appel Ollama (format OpenAI) ----------
async function callOllama(messages, { image, maxTokens } = {}) {
  // Les photos demandent un peu plus de marge (lecture du cahier), le texte reste court.
  const body = { model: image ? VISION_MODEL : MODEL, messages, temperature: 0.4, max_tokens: maxTokens || (image ? 500 : 320) };
  if (image) {
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') {
      last.content = [
        { type: 'text', text: last.content },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }
      ];
    }
  }
  const r = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Ollama ${r.status}: ${t.slice(0, 300)}`);
  }
  const j = await r.json();
  const m = j.choices?.[0]?.message || {};
  // Les modeles "raisonneurs" mettent parfois tout dans reasoning
  // (content vide quand le budget de tokens est epuise a reflechir).
  return { content: m.content || '', reasoning: m.reasoning || '' };
}

// Appel Ollama en streaming : pousse chaque morceau de texte a onDelta
async function streamOllama(messages, { image, maxTokens, onDelta } = {}) {
  // Comme pour callOllama : la photo est jointe au dernier message utilisateur
  if (image) {
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') {
      last.content = [
        { type: 'text', text: last.content },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }
      ];
    }
  }
  const body = { model: image ? VISION_MODEL : MODEL, messages, temperature: 0.4, max_tokens: maxTokens || (image ? 500 : 320), stream: true };
  const r = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Ollama ${r.status}: ${t.slice(0, 300)}`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '', reasoning = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta || {};
        const d = delta.content || '';
        if (d) { full += d; if (onDelta) onDelta(d, full); }
        // Certains modeles streament leur reflexion dans "reasoning" :
        // on la garde de cote, au cas ou aucun vrai texte n'arrive.
        else if (delta.reasoning) { reasoning += delta.reasoning; }
      } catch {}
    }
  }
  if (!full.trim() && reasoning.trim()) {
    full = reasoning;
    if (onDelta) onDelta(full, full);
  }
  return full;
}

// ---------- Endpoint principal (reponse en streaming) ----------
app.post('/api/chat', async (req, res) => {
  let headersSent = false;
  const send = (obj) => {
    if (!headersSent) {
      headersSent = true;
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    }
    res.write(JSON.stringify(obj) + '\n');
  };
  try {
    const { message, image, profile, history } = req.body || {};
    const text = String(message || '').trim();
    if (!text && !image) return res.status(400).json({ error: 'Message vide.' });

    const sys = buildSystemPrompt(profile);

    // On cherche des sources si la question le justifie
    let sources = [];
    const shouldSearch = image || text.length > 25 || text.includes('?') || /\d/.test(text);
    if (shouldSearch) {
      send({ type: 'status', text: 'Je cherche des sources… 🔎' });
      sources = await searchWeb(text || 'devoir scolaire');
    }

    let sourceBlock = '';
    if (sources.length) {
      sourceBlock = "\n\nVoici des sources fiables trouvees sur le web. Tu PEUX t'en servir pour repondre. Si tu les utilises, cite-les (titre + lien) :\n" +
        sources.map((s, i) => `${i + 1}. ${s.title} — ${s.url}${s.snippet ? ' (' + s.snippet + ')' : ''}`).join('\n');
    }

    const historyMsgs = Array.isArray(history)
      ? history.filter(h => h && (h.role === 'user' || h.role === 'assistant')).map(h => ({ role: h.role, content: h.content })).slice(-8)
      : [];

    const messages = [
      { role: 'system', content: sys + sourceBlock },
      ...historyMsgs,
      { role: 'user', content: text || 'Voici la photo de mon cahier / mon exercice. Aide-moi a le faire, sans me donner la reponse.' }
    ];

    send({ type: 'start', sources });
    await streamOllama(messages, { image, onDelta: (d) => send({ type: 'delta', text: d }) });
    send({ type: 'done', sources });
    res.end();
  } catch (e) {
    console.error(e);
    if (headersSent) { send({ type: 'error', error: 'Erreur : ' + e.message }); res.end(); }
    else res.status(500).json({ error: 'Erreur : ' + e.message });
  }
});

// ---------- Quiz (mode Interro) ----------
// Extrait les questions d'un texte (JSON complet, tronque, ou noye dans du texte)
function parseQuiz(raw, count) {
  if (!raw) return [];
  let arr = null;
  try { arr = JSON.parse(raw.match(/\[[\s\S]*\]/)[0]); } catch {}
  if (!Array.isArray(arr)) {
    // JSON tronque : on recupere les objets complets un par un
    arr = [];
    for (const m of raw.matchAll(/\{[^{}]*"question"[^{}]*\}/g)) {
      try { arr.push(JSON.parse(m[0])); } catch {}
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(q => q && q.question && Array.isArray(q.options) && q.options.length >= 2)
    .slice(0, count)
    .map(q => ({
      question: String(q.question),
      options: q.options.map(String).slice(0, 4),
      answer: Math.max(0, Math.min(q.options.length - 1, Number(q.answer) || 0)),
      explication: String(q.explication || '')
    }));
}

app.post('/api/quiz', async (req, res) => {
  try {
    const { topic, profile, count = 5 } = req.body || {};
    const cleanTopic = String(topic || '').trim() || 'les leçons récentes';
    const age = (profile && profile.age) || 10;
    // Prompt volontairement COURT : les modeles "raisonneurs" depensent
    // leur budget de tokens sur un long prompt et renvoient un JSON vide/tronque.
    const sys = `Tu generes un quiz pour un enfant de ${age} ans. Reponds UNIQUEMENT avec un tableau JSON (pas de texte autour, pas de markdown). Chaque element : {"question": "...", "options": ["...", "...", "...", "..."], "answer": INDEX_bonne_option_0_a_3, "explication": "une courte phrase"}. Questions en francais, simples et adaptees a ${age} ans. Les mauvaises options sont plausibles. L'index de la bonne reponse varie.`;
    const msgs = [
      { role: 'system', content: sys },
      { role: 'user', content: `Genere ${count} questions a choix multiple sur : ${cleanTopic}` }
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      const msg = await callOllama(msgs, { maxTokens: 2000 });
      // On essaie le contenu, puis le raisonnement (content peut etre vide).
      for (const raw of [msg.content, msg.reasoning]) {
        const quiz = parseQuiz(raw, count);
        if (quiz.length >= 2) return res.json({ quiz });
      }
    }
    res.json({ quiz: [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur : ' + e.message });
  }
});

// ---------- Recherche de videos YouTube ----------
function extractVideos(obj, out) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { for (const x of obj) extractVideos(x, out); return; }
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'videoRenderer' && v && typeof v === 'object') {
      const id = v.videoId;
      const title = (v.title && v.title.runs && v.title.runs[0] && v.title.runs[0].text) || '';
      let thumb = (v.thumbnail && v.thumbnail.thumbnails && v.thumbnail.thumbnails[0] && v.thumbnail.thumbnails[0].url) || '';
      if (thumb.startsWith('//')) thumb = 'https:' + thumb;
      if (id) out.push({ id, title, thumbnail: thumb });
    } else {
      extractVideos(v, out);
    }
  }
}

app.get('/api/videos', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ videos: [] });
    const u = `https://www.youtube.com/results?search_query=${encodeURIComponent(q + ' cours enfants')}&hl=fr`;
    const html = await fetch(u, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
      signal: AbortSignal.timeout(9000)
    }).then(r => r.text());

    const videos = [];
    const start = html.indexOf('ytInitialData');
    if (start >= 0) {
      const eq = html.indexOf('{', start);
      let depth = 0, end = eq;
      for (let i = eq; i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      try { extractVideos(JSON.parse(html.slice(eq, end)), videos); } catch {}
    }
    const seen = new Set();
    res.json({ videos: videos.filter(v => { if (seen.has(v.id)) return false; seen.add(v.id); return true; }).slice(0, 8) });
  } catch (e) {
    console.error(e);
    res.json({ videos: [] });
  }
});

// ---------- QR code de connexion ----------
function lanUrls() {
  return lanIps().map(ip => `https://${ip}:${HTTPS_PORT}`);
}

// Tunnel public (cloudflared) : le telephone peut se connecter de n'importe
// ou tant que le PC est allume, avec un vrai HTTPS (pas de certificat a installer).
const TUNNEL_EXE = path.join(__dirname, 'cloudflared.exe');
let tunnelUrl = '';
function startTunnel() {
  if (process.env.NO_HTTPS || !fs.existsSync(TUNNEL_EXE)) return;
  try {
    const p = spawn(TUNNEL_EXE, ['tunnel', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const grab = (buf) => {
      const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !tunnelUrl) {
        tunnelUrl = m[0];
        console.log(`  🌍 Depuis n'importe ou (PC allume) :  ${tunnelUrl}`);
      }
    };
    p.stdout.on('data', grab);
    p.stderr.on('data', grab);
    p.on('exit', () => { tunnelUrl = ''; });
  } catch (e) { console.error('Tunnel:', e.message); }
}

// Ouvre le navigateur en forcant Chrome (meilleure voix / micro)
function openBrowser(url) {
  if (process.platform === 'win32') {
    const candidates = [
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ].filter(Boolean);
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        exec(`start "" "${c}" "${url}"`, () => {});
        return;
      }
    }
    exec(`start "" "${url}"`, () => {});
  } else if (process.platform === 'darwin') {
    exec(`open "${url}"`, () => {});
  } else {
    exec(`xdg-open "${url}"`, () => {});
  }
}

app.get('/api/qr', async (req, res) => {
  try {
    const urls = lanUrls();
    const url = urls[0] || `http://localhost:${PORT}`;
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 300 });
    res.json({ qr, url, urls, tunnel_url: tunnelUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Profils (partages entre tous les appareils) ----------
app.get('/api/profiles', (req, res) => {
  const data = getData();
  res.json(data.profiles || []);
});

app.post('/api/profiles', (req, res) => {
  const { profiles } = req.body || {};
  if (!Array.isArray(profiles)) return res.status(400).json({ error: 'profiles invalide' });
  const data = getData();
  data.profiles = profiles;
  setData(data);
  res.json({ ok: true });
});

// ---------- Score d'interro (mode quiz) ----------
app.post('/api/quiz-score', (req, res) => {
  const { id, topic, score, total } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id manquant' });
  const data = getData();
  const child = data[id] || { name: '', age: null, history: [], sessions: [] };
  child.sessions.push({
    type: 'quiz',
    topic: 'Interro : ' + String(topic || 'leçon').slice(0, 40),
    date: new Date().toISOString(),
    count: Number(total) || 0,
    score: Number(score) || 0
  });
  data[id] = child;
  setData(data);
  res.json({ ok: true });
});

// ---------- Progression des enfants ----------
app.get('/api/child', (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id manquant' });
  const data = getData();
  res.json(data[id] || { name: '', age: null, history: [], sessions: [] });
});

app.post('/api/child', (req, res) => {
  const { id, name, age, history, action } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id manquant' });
  const data = getData();
  const child = data[id] || { name: '', age: null, history: [], sessions: [] };
  if (name) child.name = name;
  if (age != null) child.age = age;
  if (action === 'archive') {
    // on met d'abord a jour avec l'historique envoye (au cas ou aucune sauvegarde n'ait eu lieu avant)
    if (Array.isArray(history) && history.length) child.history = history;
    if (Array.isArray(child.history) && child.history.length) {
      const h = child.history;
      child.sessions.push({
        topic: topicLabel(h),
        date: new Date().toISOString(),
        count: h.filter(m => m.role === 'assistant').length,
        messages: h.slice(-60) // conversation complete, pour l'historique
      });
      child.history = [];
    }
  } else if (Array.isArray(history)) {
    child.history = history;
  }
  data[id] = child;
  setData(data);
  res.json({ ok: true });
});

// ---------- Demarrage ----------
(async () => {
  await initStore();

  // HTTP : pour l'ordinateur (localhost = contexte sécurisé, pas d'avertissement)
  http.createServer(app).listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ✅ Lumi demarree !`);
    console.log(`  💻 Sur cet ordinateur :  http://localhost:${PORT}`);
    if (!process.env.NO_OPEN_BROWSER) {
      openBrowser(`http://localhost:${PORT}`);
    }
    startTunnel(); // ouvre une porte publique (PC allume) pour le telephone
  });

  // HTTPS auto-signé : utile seulement en local, pour le telephone.
  // En ligne (Render, etc.) l'hebergeur fait deja du vrai HTTPS -> NO_HTTPS=1
  if (process.env.NO_HTTPS) return;

  const { cert, key } = await getOrCreateCert();
  https.createServer({ cert, key }, app).listen(HTTPS_PORT, '0.0.0.0', () => {
    const urls = lanUrls();
    urls.forEach(u => console.log(`  📱 Depuis le telephone (meme Wi-Fi) :  ${u}`));
    console.log('  (sur le telephone, au 1er acces : "Parametres avances" puis "Continuer")');
    console.log('');
    if (urls.length) {
      QRCode.toString(urls[0], { type: 'terminal', small: true }).then(qr => {
        console.log('  Scanne ce QR code avec l appareil photo du telephone :\n');
        console.log(qr);
        console.log('');
      }).catch(() => {});
    }
  });
})().catch(e => console.error('Erreur demarrage :', e));
