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
// V2 : base SQL (SQLite integree a Node, zero dependance). Les donnees
// vivent dedans : une ligne par compte, par enfant, PAR MESSAGE de
// conversation. Le fichier JSON n'est plus qu'un heritage a importer.
const SQLITE_FILE = path.join(DATA_DIR, 'lumi.sqlite');

const KV_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

// Sur Deno Deploy (hebergement gratuit) : le disque est en lecture seule,
// mais une base KV gratuite est integree. On l'utilise si elle existe.
const isDeno = typeof globalThis.Deno !== 'undefined';
let denoKv = null;

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return {};
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
// Base SQL : ouverte au demarrage. Si indisponible (tres vieux Node, vm des
// tests), on retombe sur le stockage blob ci-dessous (JSON / Redis / Deno KV).
let sql = null;
async function initSql() {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    sql = new DatabaseSync(SQLITE_FILE);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE,
        pass_hash TEXT NOT NULL,
        plan TEXT NOT NULL,
        trial_ends TEXT,
        consent_date TEXT,
        created TEXT NOT NULL,
        settings TEXT NOT NULL DEFAULT '{}',
        usage TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        expires TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS children (
        account_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        age INTEGER,
        data TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (account_id, id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        child_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_child
        ON messages (account_id, child_id, seq);
    `);
  } catch (e) {
    sql = null;
    if (!KV_URL) console.warn('  ⚠️ Base SQL indisponible (' + e.message + ') : repli sur le fichier JSON.');
  }
}
// RGPD (limitation de conservation) : les conversations actives de plus de
// LUMI_RETENTION_MONTHS mois (12 par defaut, 0 = garder indefiniment) sont
// effacees au demarrage. Les resumes archives (sessions) restent, ils sont
// compacts et servent a la progression.
function purgeOldMessages() {
  if (!sql) return;
  const months = Number((globalThis.process && globalThis.process.env && globalThis.process.env.LUMI_RETENTION_MONTHS) || 12);
  if (!months || months <= 0) return;
  const cutoff = new Date(Date.now() - months * 30.5 * 86400000).toISOString();
  const r = sql.prepare('DELETE FROM messages WHERE created < ?').run(cutoff);
  if (r.changes) console.log('  🧹 RGPD : ' + r.changes + ' vieux messages purgés (>' + months + ' mois).');
}
function saveData(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = DATA_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, DATA_FILE);
}

let memData = null;
async function kvRequest(endpoint, options = {}) {
  const r = await fetch(KV_URL + endpoint, {
    ...options, signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + KV_TOKEN, 'Content-Type': 'text/plain' }
  });
  if (!r.ok) throw new Error('Stockage distant indisponible (' + r.status + ')');
  const j = await r.json();
  if (j.error) throw new Error('Erreur du stockage distant');
  return j;
}
async function initStore() {
  if (isDeno) denoKv = await Deno.openKv();
  if (denoKv) {
    memData = (await denoKv.get(['lumi-data'])).value || {};
  } else if (KV_URL && KV_TOKEN) {
    const j = await kvRequest('/get/lumi-data');
    memData = j.result ? JSON.parse(j.result) : {};
  } else {
    // V2 : la base SQL est la source de verite en local. Au tout premier
    // lancement, l'ancien fichier JSON est importee dedans (fichier conserve
    // tel quel = sauvegarde). Un import rate = demarrage refuse (RGPD : on
    // ne demarre jamais sur des donnees perdues a moitie).
    await initSql();
    if (sql) {
      try {
        const count = sql.prepare('SELECT COUNT(*) AS c FROM accounts').get().c;
        if (!count && fs.existsSync(DATA_FILE)) {
          importJsonToSql(loadData());
          console.log('  📦 Anciennes données importées dans la base SQL (data/lumi.sqlite).');
        }
      } catch (e) {
        throw new Error('Import des anciennes données impossible : ' + e.message);
      }
      purgeOldMessages();
      memData = {};
      return;
    }
    memData = loadData();
  }
  if (!memData || typeof memData !== 'object' || Array.isArray(memData)) {
    memData = null;
    throw new Error('Données invalides : démarrage interrompu pour les préserver.');
  }
  // V2 : migre l'ancien format (profils a plat) vers le format comptes famille.
  // Sauvegarde du fichier d'origine d'abord (mode fichier local uniquement).
  const migrated = migrateLegacy(memData);
  if (migrated !== memData) {
    try {
      if (!denoKv && !KV_URL && fs.copyFileSync) fs.copyFileSync(DATA_FILE, DATA_FILE + '.pre-v2.json');
    } catch {}
    memData = migrated;
    await setData(migrated);
    console.log('  📦 Données migrées vers le format V2 (compte local). Sauvegarde : lumi-data.pre-v2.json');
  }
}
function getData() {
  if (!memData) throw new Error('Stockage non initialisé');
  return structuredClone(memData);
}
async function setData(data) {
  if (!memData) throw new Error('Stockage non initialisé');
  if (denoKv) {
    const result = await denoKv.set(['lumi-data'], data);
    if (!result.ok) throw new Error('Sauvegarde refusée');
  } else if (KV_URL && KV_TOKEN) {
    await kvRequest('/set/lumi-data', { method: 'POST', body: JSON.stringify(data) });
  } else {
    saveData(data);
  }
  memData = data;
}
// Sérialise les modifications pour ne jamais publier un état non sauvegardé.
let writeQueue = Promise.resolve();
function storedRoute(handler) {
  return (req, res) => {
    const task = writeQueue.then(() => handler(req, res));
    writeQueue = task.catch(() => {});
    task.catch(e => {
      console.error('Sauvegarde:', e.message);
      if (!res.headersSent) res.status(503).json({ error: 'Sauvegarde impossible. Réessaie avant de quitter la leçon.' });
    });
  };
}

// ---------- Migration V2 : donnees a plat -> compte local ----------
// Avant la V2, les profils et les enfants etaient ranges a plat dans le blob.
// On les deplace dans l'espace du compte implicite "local", une seule fois,
// sans rien perdre. Pure et idempotente : sans profils a la racine, ne touche
// a rien (les tests fournissent des donnees sans "profiles").
function migrateLegacy(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  if (!Array.isArray(data.profiles) || data.spaces) return data;
  const space = {};
  for (const [k, v] of Object.entries(data)) space[k] = v;
  const accounts = (data.accounts && typeof data.accounts === 'object') ? data.accounts : {};
  if (!accounts.local) {
    accounts.local = {
      id: 'local', email: '', passHash: '', plan: 'local', consentParental: true,
      created: new Date().toISOString(), settings: { dailyLimit: null, childLimits: {} }, usage: {}
    };
  }
  return {
    accounts,
    sessions: (data.sessions && typeof data.sessions === 'object') ? data.sessions : {},
    spaces: { local: space }
  };
}
// Import du blob (JSON herite) vers la base SQL, une seule fois au premier
// demarrage. Les conversations (history de chaque enfant) deviennent des
// lignes de la table messages ; le resume archive va dans children.data.
function importJsonToSql(raw) {
  const migrated = migrateLegacy(raw);
  if (!migrated || typeof migrated !== 'object' || Array.isArray(migrated)) return;
  const now = new Date().toISOString();
  const putAccount = sql.prepare('INSERT OR REPLACE INTO accounts (id,email,pass_hash,plan,trial_ends,consent_date,created,settings,usage) VALUES (?,?,?,?,?,?,?,?,?)');
  for (const acc of Object.values(migrated.accounts || {})) {
    putAccount.run(acc.id, acc.email || '', acc.passHash || '', acc.plan || 'free',
      acc.trialEnds || null, acc.created || null, acc.created || now,
      JSON.stringify(acc.settings || {}), JSON.stringify(acc.usage || {}));
  }
  const putSession = sql.prepare('INSERT OR REPLACE INTO sessions (token,account_id,expires) VALUES (?,?,?)');
  for (const [token, s] of Object.entries(migrated.sessions || {})) putSession.run(token, s.accountId, s.expires || '');
  const putChild = sql.prepare('INSERT OR REPLACE INTO children (account_id,id,name,age,data) VALUES (?,?,?,?,?)');
  const putMsg = sql.prepare('INSERT INTO messages (account_id,child_id,role,content,created) VALUES (?,?,?,?,?)');
  for (const [accId, space] of Object.entries(migrated.spaces || {})) {
    const profiles = Array.isArray(space.profiles) ? space.profiles : [];
    for (const p of profiles) {
      const c = (space[p.id] && typeof space[p.id] === 'object') ? space[p.id] : {};
      putChild.run(accId, p.id, c.name || p.name || '', (c.age ?? p.age) ?? null,
        JSON.stringify({ sessions: Array.isArray(c.sessions) ? c.sessions : [] }));
      const hist = Array.isArray(c.history) ? c.history : [];
      hist.forEach(m => putMsg.run(accId, p.id, String(m.role || 'user'), String(m.content || ''), now));
    }
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

// ---------- Comptes famille (V2) ----------
// Objectif : pouvoir vendre Lumi plus tard. Un parent cree un compte
// (e-mail + mot de passe), ses enfants vivent dans son "espace", isole des
// autres comptes. Le mode local (la famille actuelle) reste transparent :
// sans compte connecte et LUMI_LOCAL_MODE=1 (defaut), on attribue le compte
// implicite "local" (illimite). Pour vendre : LUMI_LOCAL_MODE=0.
const ENV = (globalThis.process && globalThis.process && globalThis.process.env) || {};
const LOCAL_MODE = ENV.LUMI_LOCAL_MODE !== '0';
const SESSION_COOKIE = 'lumi_session';
const SESSION_DAYS = 30;

// --- Mots de passe : PBKDF2 via webcrypto (marche en Node ET Deno, aucune dependance) ---
function bufToB64(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}
function b64ToBuf(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
async function hashPassword(password) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const key = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return 'pbkdf2:' + bufToB64(salt) + ':' + bufToB64(bits);
}
async function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split(':');
    if (parts[0] !== 'pbkdf2' || !parts[1] || !parts[2]) return false;
    const key = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']);
    const bits = await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64ToBuf(parts[1]), iterations: 100000 }, key, 256);
    return bufToB64(bits) === parts[2];
  } catch { return false; }
}
function newToken() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}
function localAccount() {
  return {
    id: 'local', email: '', passHash: '', plan: 'local', consentParental: true,
    created: new Date().toISOString(), settings: { dailyLimit: null, childLimits: {} }, usage: {}
  };
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function sessionCookie(token, req, maxAgeSec) {
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return SESSION_COOKIE + '=' + token + '; Path=/; HttpOnly; Max-Age=' + maxAgeSec + '; SameSite=Lax' + (secure ? '; Secure' : '');
}
// Trouve le compte de la requete : session valide, sinon compte local (mode
// local), sinon rien (mode vente : le front montre l'ecran de connexion).
async function resolveAccount(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) {
    const s = await sessionGet(token);
    if (s && (!s.expires || new Date(s.expires) > new Date())) {
      const acc = await accountById(s.accountId);
      if (acc) return { account: acc, local: false };
    }
  }
  if (LOCAL_MODE) {
    const acc = await accountById('local');
    return { account: acc || localAccount(), local: true };
  }
  return null;
}
async function requireAccount(req, res) {
  const r = await resolveAccount(req);
  if (!r) { res.status(401).json({ error: 'Connecte-toi à ton compte famille pour utiliser Lumi.' }); return null; }
  return r;
}
// --- Acces aux donnees : base SQL si dispo, sinon blob (Redis/Deno pour l'hebergement) ---
function rowToAccount(r) {
  return {
    id: r.id, email: r.email, passHash: r.pass_hash, plan: r.plan,
    trialEnds: r.trial_ends || null, consentDate: r.consent_date || null, created: r.created,
    settings: JSON.parse(r.settings || '{}'), usage: JSON.parse(r.usage || '{}')
  };
}
async function accountByEmail(mail) {
  if (sql) { const r = sql.prepare('SELECT * FROM accounts WHERE email = ?').get(mail); return r ? rowToAccount(r) : null; }
  return Object.values(getData().accounts || {}).find(a => a && a.email === mail) || null;
}
async function accountById(id) {
  if (sql) { const r = sql.prepare('SELECT * FROM accounts WHERE id = ?').get(id); return r ? rowToAccount(r) : null; }
  return (getData().accounts || {})[id] || null;
}
async function accountPut(acc) {
  if (sql) {
    sql.prepare('INSERT OR REPLACE INTO accounts (id,email,pass_hash,plan,trial_ends,consent_date,created,settings,usage) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(acc.id, acc.email || '', acc.passHash || '', acc.plan || 'free', acc.trialEnds || null,
        acc.consentDate || null, acc.created || new Date().toISOString(),
        JSON.stringify(acc.settings || {}), JSON.stringify(acc.usage || {}));
    return;
  }
  const data = getData();
  data.accounts = data.accounts || {};
  data.accounts[acc.id] = acc;
  await setData(data);
}
async function sessionPut(token, s) {
  if (sql) { sql.prepare('INSERT OR REPLACE INTO sessions (token,account_id,expires) VALUES (?,?,?)').run(token, s.accountId, s.expires || ''); return; }
  const data = getData();
  data.sessions = data.sessions || {};
  data.sessions[token] = s;
  await setData(data);
}
async function sessionGet(token) {
  if (sql) { const r = sql.prepare('SELECT * FROM sessions WHERE token = ?').get(token); return r ? { accountId: r.account_id, expires: r.expires } : null; }
  return (getData().sessions || {})[token] || null;
}
async function sessionDel(token) {
  if (sql) { sql.prepare('DELETE FROM sessions WHERE token = ?').run(token); return; }
  const data = getData();
  if (data.sessions && data.sessions[token]) { delete data.sessions[token]; await setData(data); }
}
// Espace (blob) : les enfants de CETTE famille seulement, ranges dans
// spaces[accountId] = { profiles: [...], [idEnfant]: {...} }.
function blobSpace(accountId) {
  const data = getData();
  data.spaces = data.spaces || {};
  if (!data.spaces[accountId] || typeof data.spaces[accountId] !== 'object') data.spaces[accountId] = { profiles: [] };
  return data;
}
// Liste des profils : [{id, name, age}] — c'est ce que le front affiche.
async function childList(accountId) {
  if (sql) {
    return sql.prepare('SELECT id,name,age FROM children WHERE account_id = ?').all(accountId)
      .map(r => ({ id: r.id, name: r.name, age: r.age }));
  }
  const space = (getData().spaces || {})[accountId];
  return Array.isArray(space && space.profiles) ? space.profiles : [];
}
async function childGetFull(accountId, childId) {
  if (sql) {
    const r = sql.prepare('SELECT * FROM children WHERE account_id = ? AND id = ?').get(accountId, childId);
    if (!r) return { name: '', age: null, history: [], sessions: [] };
    const meta = JSON.parse(r.data || '{}');
    return {
      name: r.name, age: r.age,
      history: sql.prepare('SELECT role,content FROM messages WHERE account_id = ? AND child_id = ? ORDER BY seq').all(accountId, childId)
        .map(m => ({ role: m.role, content: m.content })),
      sessions: Array.isArray(meta.sessions) ? meta.sessions : []
    };
  }
  const space = (getData().spaces || {})[accountId];
  const c = (space && typeof space === 'object') ? space[childId] : null;
  return c && typeof c === 'object' ? c : { name: '', age: null, history: [], sessions: [] };
}
// Sauve le child complet (metadonnees + conversations remplacees par celles
// envoyees — le front envoie toujours l'historique complet de la lecon).
async function childSave(accountId, childId, child) {
  if (sql) {
    sql.prepare('INSERT INTO children (account_id,id,name,age,data) VALUES (?,?,?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET name=excluded.name, age=excluded.age, data=excluded.data')
      .run(accountId, childId, child.name || '', child.age ?? null,
        JSON.stringify({ sessions: Array.isArray(child.sessions) ? child.sessions : [] }));
    sql.prepare('DELETE FROM messages WHERE account_id = ? AND child_id = ?').run(accountId, childId);
    const put = sql.prepare('INSERT INTO messages (account_id,child_id,role,content,created) VALUES (?,?,?,?,?)');
    const now = new Date().toISOString();
    for (const m of (Array.isArray(child.history) ? child.history : [])) {
      if (m && (m.role === 'user' || m.role === 'assistant')) put.run(accountId, childId, m.role, String(m.content || ''), now);
    }
    return;
  }
  const data = blobSpace(accountId);
  data.spaces[accountId][childId] = child;
  await setData(data);
}
// Sauve seulement nom/age/resumes (sans toucher les conversations) — quiz etc.
async function childMetaSave(accountId, childId, child) {
  if (sql) {
    sql.prepare('INSERT INTO children (account_id,id,name,age,data) VALUES (?,?,?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET name=excluded.name, age=excluded.age, data=excluded.data')
      .run(accountId, childId, child.name || '', child.age ?? null,
        JSON.stringify({ sessions: Array.isArray(child.sessions) ? child.sessions : [] }));
    return;
  }
  const data = blobSpace(accountId);
  const c = data.spaces[accountId][childId] || { name: '', age: null, history: [], sessions: [] };
  c.name = child.name || c.name;
  c.age = child.age ?? c.age;
  c.sessions = child.sessions;
  data.spaces[accountId][childId] = c;
  await setData(data);
}
// Le front envoie la liste COMPLETE des profils : on ajoute/modifie, et on
// efface ce qui a disparu (donnees + conversations — minimisation RGPD).
async function childSaveList(accountId, profiles) {
  const clean = profiles.filter(p => p && typeof p.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(p.id));
  if (sql) {
    for (const p of clean) {
      sql.prepare('INSERT INTO children (account_id,id,name,age,data) VALUES (?,?,?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET name=excluded.name, age=excluded.age')
        .run(accountId, p.id, String(p.name || ''), (p.age ?? null) | 0 || null, JSON.stringify({}));
    }
    const ids = clean.map(p => p.id);
    const kept = new Set(ids);
    for (const r of sql.prepare('SELECT id FROM children WHERE account_id = ?').all(accountId)) {
      if (!kept.has(r.id)) {
        sql.prepare('DELETE FROM messages WHERE account_id = ? AND child_id = ?').run(accountId, r.id);
        sql.prepare('DELETE FROM children WHERE account_id = ? AND id = ?').run(accountId, r.id);
      }
    }
    return;
  }
  const data = blobSpace(accountId);
  data.spaces[accountId].profiles = clean.map(p => ({ id: p.id, name: String(p.name || ''), age: p.age ?? null }));
  for (const k of Object.keys(data.spaces[accountId])) {
    if (k !== 'profiles' && !ids.includes(k)) delete data.spaces[accountId][k];
  }
  await setData(data);
}
// ---------- RGPD : droits de la famille sur ses donnees ----------
// Droit d'acces : tout ce qu'on possede sur ce compte, en un JSON.
async function accountExport(accountId) {
  const acc = await accountById(accountId);
  const out = {
    account: acc ? { email: acc.email, plan: acc.plan, created: acc.created, consentDate: acc.consentDate } : null,
    children: []
  };
  if (sql) {
    for (const r of sql.prepare('SELECT * FROM children WHERE account_id = ?').all(accountId)) {
      const meta = JSON.parse(r.data || '{}');
      out.children.push({
        id: r.id, name: r.name, age: r.age, sessions: meta.sessions || [],
        conversations: sql.prepare('SELECT role,content,created FROM messages WHERE account_id = ? AND child_id = ? ORDER BY seq').all(accountId, r.id)
      });
    }
    return out;
  }
  const space = (getData().spaces || {})[accountId];
  if (space && typeof space === 'object') {
    for (const p of (Array.isArray(space.profiles) ? space.profiles : [])) {
      const c = space[p.id] || {};
      out.children.push({ id: p.id, name: c.name || p.name, age: c.age ?? p.age, sessions: c.sessions || [], conversations: c.history || [] });
    }
  }
  return out;
}
// Droit a l'effacement : suppression DEFINITIVE et verifiable de tout le
// compte (conversations, enfants, sessions). Rien ne reste nulle part.
async function accountErase(accountId) {
  if (sql) {
    sql.prepare('DELETE FROM messages WHERE account_id = ?').run(accountId);
    sql.prepare('DELETE FROM children WHERE account_id = ?').run(accountId);
    sql.prepare('DELETE FROM sessions WHERE account_id = ?').run(accountId);
    sql.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
    return;
  }
  const data = getData();
  delete (data.accounts || {})[accountId];
  delete (data.spaces || {})[accountId];
  for (const [token, s] of Object.entries(data.sessions || {})) {
    if (s && s.accountId === accountId) delete data.sessions[token];
  }
  await setData(data);
}

app.post('/api/auth/register', storedRoute(async (req, res) => {
  const { email, password, consent } = req.body || {};
  const mail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return res.status(400).json({ error: 'Adresse e-mail invalide.' });
  if (String(password || '').length < 6) return res.status(400).json({ error: 'Choisis un mot de passe de 6 caractères ou plus.' });
  if (!consent) return res.status(400).json({ error: 'Le consentement parental est obligatoire pour créer un compte.' });
  if (await accountByEmail(mail)) return res.status(409).json({ error: 'Un compte existe déjà avec cet e-mail. Connecte-toi plutôt.' });
  const id = 'a' + newToken().slice(0, 12);
  // RGPD : consentement parental horodate (preuve de quand il a ete donne).
  // 14 jours d'essai complet, sans carte bancaire (bascule silencieuse en
  // "free" ensuite — la duree et les limites seront gerees en Phase 2).
  await accountPut({
    id, email: mail, passHash: await hashPassword(password), plan: 'trial',
    trialEnds: new Date(Date.now() + 14 * 86400000).toISOString(),
    consentDate: new Date().toISOString(),
    created: new Date().toISOString(), settings: { dailyLimit: null, childLimits: {} }, usage: {}
  });
  const token = newToken();
  await sessionPut(token, { accountId: id, expires: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString() });
  res.setHeader('Set-Cookie', sessionCookie(token, req, SESSION_DAYS * 86400));
  res.json({ ok: true, account: { email: mail, plan: 'trial' } });
}));

app.post('/api/auth/login', storedRoute(async (req, res) => {
  const { email, password } = req.body || {};
  const mail = String(email || '').trim().toLowerCase();
  const acc = await accountByEmail(mail);
  if (!acc || !(await verifyPassword(password, acc.passHash))) {
    return res.status(401).json({ error: 'E-mail ou mot de passe incorrect.' });
  }
  const token = newToken();
  await sessionPut(token, { accountId: acc.id, expires: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString() });
  res.setHeader('Set-Cookie', sessionCookie(token, req, SESSION_DAYS * 86400));
  res.json({ ok: true, account: { email: acc.email, plan: acc.plan, trialEnds: acc.trialEnds || null } });
}));

app.post('/api/auth/logout', storedRoute(async (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) await sessionDel(token);
  res.setHeader('Set-Cookie', sessionCookie('', req, 0));
  res.json({ ok: true });
}));

app.get('/api/auth/me', async (req, res) => {
  const r = await resolveAccount(req);
  if (!r) return res.json({ localMode: LOCAL_MODE, account: null });
  res.json({
    localMode: LOCAL_MODE, local: r.local,
    account: { email: r.account.email || '', plan: r.account.plan, trialEnds: r.account.trialEnds || null }
  });
});

// ---------- RGPD : export et effacement du compte ----------
// Droit d'acces (art. 15) : la famille recupere TOUTES ses donnees en JSON.
app.get('/api/account/export', async (req, res) => {
  const r = await resolveAccount(req);
  if (!r) return res.status(401).json({ error: 'Connecte-toi à ton compte famille pour exporter tes données.' });
  if (r.local) return res.status(400).json({ error: 'En mode sans compte, il n’y a rien à exporter. Crée un compte famille pour ça.' });
  res.setHeader('Content-Disposition', 'attachment; filename="lumi-donnees.json"');
  res.json(await accountExport(r.account.id));
});
// Droit a l'effacement (art. 17) : suppression definitive de TOUT, mot de
// passe exige. Rien n'est conserve (ni conversations, ni sessions, ni e-mail).
app.post('/api/account/delete', storedRoute(async (req, res) => {
  const r = await requireAccount(req, res);
  if (!r) return;
  if (r.local) return res.status(400).json({ error: 'Le mode sans compte n’a pas de données à supprimer.' });
  const { password } = req.body || {};
  if (!(await verifyPassword(String(password || ''), r.account.passHash))) {
    return res.status(401).json({ error: 'Mot de passe incorrect : suppression refusée.' });
  }
  await accountErase(r.account.id);
  res.setHeader('Set-Cookie', sessionCookie('', req, 0));
  res.json({ ok: true });
}));
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
6. Tu reponds TOUJOURS en francais, quel que soit le sujet ou la langue de la question : jamais un seul mot en anglais.
7. Tu t adresses TOUJOURS directement a l enfant : tu le tutoies et tu utilises son prenom. Tu ne parles JAMAIS de lui a la 3e personne ("l enfant", "l eleve", "the user") ni de toi-meme comme d un tiers : c est toi, Lumi, qui lui parles.
8. Tu restes TRES bref : maximum 3 phrases courtes par reponse (2, c'est encore mieux). Pas de longues listes a puces (une seule au grand maximum). Va droit au but : pas de salutations repetees, pas de recapitulatif. Si l'enfant demande une explication complete, tu peux aller jusqu'a 5 phrases, jamais plus.
9. Pour les maths, ecris les fractions, puissances et calculs entre $ ... $ (LaTeX) pour un bel affichage. Exemple : $\\frac{3}{4}$ ou $3 \\times 4$.
10. Tu AVANCES la lecon a chaque reponse. Tu ne recopies JAMAIS mot pour mot la question de l enfant. Tu ne reposes JAMAIS une question deja posee dans l historique : relis l historique avant de repondre. Chaque reponse apporte du NOUVEAU (un indice different, une etape de plus, une nouvelle question). Si l enfant repete sa question, ne la recite pas : reponds autrement en reformulant avec tes mots.

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
// Budget de reponse : glm-5.3-flash "reflechit" avant de repondre, et son
// raisonnement consomme le budget de tokens. A 320, la reponse arrivait
// coupee en pleine phrase (lecture vocale incomplete). Le plafond n'est pas
// une cible : seuls les tokens vraiment produits sont factures.
const REPLY_TOKENS = 700;
// La photo du cahier est LA base de Lumi : le modele vision doit d'abord
// decrire l'enonce, puis guider — et son raisonnement interne consommait
// les 600 tokens (reponse coupee, ou raisonnement anglais qui fuyait dans
// la bulle). Budget plus large : seuls les tokens produits sont factures.
const PHOTO_TOKENS = 900;
// glm-5.3-flash "reflechit" avant de repondre : sans cette option, son
// raisonnement (en anglais) consommait TOUT le budget de tokens et la
// vraie reponse arrivait vide ou coupee. "low" = reflexion minimale,
// reponse complete en francais, ~3 fois moins de tokens consommes.
const REASONING_EFFORT = process.env.OLLAMA_REASONING_EFFORT || 'low';
async function callOllama(messages, { image, maxTokens } = {}) {
  // Les photos demandent un peu plus de marge (lecture du cahier), le texte reste court.
  const body = { model: image ? VISION_MODEL : MODEL, messages, temperature: 0.4, reasoning_effort: REASONING_EFFORT, max_tokens: maxTokens || (image ? PHOTO_TOKENS : REPLY_TOKENS) };
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
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000)
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

// Bilan pedagogique pour les parents : a l'archivage d'une lecon, l'IA lit
// la conversation et produit un TITRE de lecon + ce que l'enfant a reussi +
// ce qu'il faut encore retravailler. Budget compact, francais uniquement.
// Renvoie null en cas d'echec (jamais de blocage de l'archivage).
async function summarizeLesson(history, profile = {}) {
  const msgs = (Array.isArray(history) ? history : [])
    .filter(h => h && (h.role === 'user' || h.role === 'assistant'))
    .slice(-40)
    .map(h => (h.role === 'user' ? 'Enfant : ' : 'Lumi : ') + String(h.content || '').slice(0, 500));
  if (msgs.length < 2) return null;
  const age = profile.age ?? 10;
  const r = await callOllama([
    { role: 'system', content: `Tu lis la conversation d'un enfant de ${age} ans avec son tuteur. Reponds UNIQUEMENT par un objet JSON compact, sans texte autour : {"titre":"titre court de la lecon, max 40 caracteres","reussi":["max 3 choses comprises, max 60 caracteres chacune"],"a_travailler":["max 2 points a retravailler, max 60 caracteres chacun"]}. Tout en francais.` },
    { role: 'user', content: msgs.join('\n').slice(0, 8000) }
  ], { maxTokens: 350 });
  const raw = String(r.content || '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const list = v => (Array.isArray(v) ? v : []).map(String).filter(Boolean).slice(0, 3);
    return {
      titre: String(j.titre || '').slice(0, 60) || null,
      reussi: list(j.reussi),
      a_travailler: list(j.a_travailler).slice(0, 2)
    };
  } catch { return null; }
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
  const body = { model: image ? VISION_MODEL : MODEL, messages, temperature: 0.4, reasoning_effort: REASONING_EFFORT, max_tokens: maxTokens || (image ? PHOTO_TOKENS : REPLY_TOKENS), stream: true };
  const r = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000)
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
    const acc = await resolveAccount(req);
    if (!acc) return res.status(401).json({ error: 'Connecte-toi à ton compte famille pour utiliser Lumi.' });

    const sys = buildSystemPrompt(profile) + (image ? `

PHOTO DU CAHIER (tres important) :
- Commence par dire en 1-2 phrases TRES courtes ce que tu vois : la matiere et ce que demande l'exercice. L'enfant doit etre sur que tu as bien lu sa photo.
- Puis guide avec des questions, comme d'habitude : jamais la reponse finale.
- Photo illisible, floue, ou pas un exercice ? Dis-le gentiment et demande une nouvelle photo.` : '');

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

    // Contexte de la lecon : assez de messages pour que Lumi se souvienne du
    // debut (8 messages = elle oubliait vite), mais avec un budget de caracteres
    // pour maitriser le cout d'entree. On garde toujours les plus recents.
    const recentHistory = (list, maxMsgs = 16, maxChars = 6000) => {
      const msgs = (Array.isArray(list) ? list : [])
        .filter(h => h && (h.role === 'user' || h.role === 'assistant'))
        .map(h => ({ role: h.role, content: String(h.content || '') }))
        .slice(-maxMsgs);
      let total = 0;
      const out = [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const len = msgs[i].content.length;
        if (total + len > maxChars && out.length) break;
        total += len;
        out.unshift(msgs[i]);
      }
      return out;
    };

    const historyMsgs = recentHistory(history);

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
    .filter(q => q && q.question && Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length)
    .slice(0, count)
    .map(q => ({
      question: String(q.question),
      options: q.options.map(String).slice(0, 4),
      answer: q.answer,
      explication: String(q.explication || '')
    }));
}

app.post('/api/quiz', async (req, res) => {
  try {
    const acc = await resolveAccount(req);
    if (!acc) return res.status(401).json({ error: 'Connecte-toi à ton compte famille pour utiliser Lumi.' });
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
        console.log('  📱 IPHONE / ANDROID : scanne plutot ce QR code (micro et voix garantis) :\n');
        QRCode.toString(tunnelUrl, { type: 'terminal', small: true })
          .then(qr => console.log(qr + '\n'))
          .catch(() => {});
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
    // On prefere le tunnel (vrai HTTPS) : l'adresse locale utilise un
    // certificat auto-signe, et sans certificat installe l'iPhone bloque
    // le micro, la reconnaissance vocale et la camera, quel que soit le
    // navigateur (tous utilisent Safari/WebKit sur iPhone).
    const url = tunnelUrl || urls[0] || `http://localhost:${PORT}`;
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 300 });
    res.json({ qr, url, urls, tunnel_url: tunnelUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Profils (partages entre tous les appareils, isoles par compte) ----------
app.get('/api/profiles', async (req, res) => {
  const r = await requireAccount(req, res);
  if (!r) return;
  res.json(await childList(r.account.id));
});

app.post('/api/profiles', storedRoute(async (req, res) => {
  const r = await requireAccount(req, res);
  if (!r) return;
  const { profiles } = req.body || {};
  if (!Array.isArray(profiles)) return res.status(400).json({ error: 'profiles invalide' });
  await childSaveList(r.account.id, profiles);
  res.json({ ok: true });
}));

// ---------- Score d'interro (mode quiz) ----------
app.post('/api/quiz-score', storedRoute(async (req, res) => {
  const r = await requireAccount(req, res);
  if (!r) return;
  const { id, topic, score, total } = req.body || {};
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || ['profiles', '__proto__', 'constructor', 'prototype'].includes(id)) return res.status(400).json({ error: 'id invalide' });
  const child = await childGetFull(r.account.id, id);
  child.sessions.push({
    type: 'quiz',
    topic: 'Interro : ' + String(topic || 'leçon').slice(0, 40),
    date: new Date().toISOString(),
    count: Number(total) || 0,
    score: Number(score) || 0
  });
  await childMetaSave(r.account.id, id, child);
  res.json({ ok: true });
}));

// ---------- Progression des enfants ----------
app.get('/api/child', async (req, res) => {
  const r = await requireAccount(req, res);
  if (!r) return;
  const id = String(req.query.id || '').trim();
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || ['profiles', '__proto__', 'constructor', 'prototype'].includes(id)) return res.status(400).json({ error: 'id invalide' });
  res.json(await childGetFull(r.account.id, id));
});

app.post('/api/child', storedRoute(async (req, res) => {
  const r = await requireAccount(req, res);
  if (!r) return;
  const { id, name, age, history, action } = req.body || {};
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || ['profiles', '__proto__', 'constructor', 'prototype'].includes(id)) return res.status(400).json({ error: 'id invalide' });
  const child = await childGetFull(r.account.id, id);
  if (name) child.name = name;
  if (age != null) child.age = age;
  if (action === 'archive') {
    // on met d'abord a jour avec l'historique envoye (au cas ou aucune sauvegarde n'ait eu lieu avant)
    if (Array.isArray(history) && history.length) child.history = history;
    if (Array.isArray(child.history) && child.history.length) {
      const h = child.history;
      // Bilan pour les parents : titre + reussites + points a retravailler.
      // Si l'IA echoue, on archive quand meme avec le titre simple.
      let bilan = null;
      try { bilan = await summarizeLesson(h, { name: child.name, age: child.age }); } catch {}
      child.sessions.push({
        topic: (bilan && bilan.titre) || topicLabel(h),
        date: new Date().toISOString(),
        count: h.filter(m => m.role === 'assistant').length,
        messages: h.slice(-60), // conversation complete, pour l'historique
        reussi: bilan ? bilan.reussi : [],
        a_travailler: bilan ? bilan.a_travailler : []
      });
      child.history = [];
    }
  } else if (Array.isArray(history)) {
    child.history = history;
  }
  await childSave(r.account.id, id, child);
  res.json({ ok: true });
}));

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
