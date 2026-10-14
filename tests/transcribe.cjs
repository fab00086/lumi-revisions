const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { createHash, createHmac, timingSafeEqual, webcrypto } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function section(a, b) { const start = source.indexOf(a), end = source.indexOf(b, start); assert.ok(start >= 0 && end > start, a); return source.slice(start, end); }

// Fixture : stockage KV factice + serveur Whisper factice (API Whishper).
// Le serveur Lumi ne parle jamais au vrai Whisper dans les tests.
async function fixture(env = {}, nativeRunner) {
  const { createWhisperRunner } = await import('../whisper-python.js');
  const records = [];
  let remote = '{}';
  const whisper = { posts: [], gets: 0, deleted: [] };
  let whisperState = { status: 2, text: 'bonjour les enfants.' };
  const ok = json => ({ ok: true, json: async () => json });
  const appProxy = {
    get: (...a) => records.push(['get', ...a]),
    post: (...a) => records.push(['post', ...a]),
    use: (...a) => records.push(['use', ...a]),
    set: () => {}
  };
  const c = vm.createContext({
    console, app: appProxy, URL, URLSearchParams, path, os, fs, Buffer, structuredClone, FormData, Blob,
    __dirname: path.resolve(__dirname, '..'),
    createWhisperRunner: nativeRunner ? () => nativeRunner : createWhisperRunner,
    createHash, createHmac, timingSafeEqual, crypto: webcrypto,
    TextEncoder, TextDecoder, AbortController, AbortSignal, setTimeout, clearTimeout, btoa, atob,
    process: { env: { LUMI_ADMIN_CODE: 'test-admin', LUMI_ACCESS_CODE: 'test-house', LUMI_PUBLIC_URL: 'https://lumi.test', LUMI_LOCAL_MODE: '0', WHISPER_API_URL: 'http://whisper.test', ...env } },
    ENV: {}, DATA_FILE: 'unused', DATA_DIR: '.', KV_URL: 'https://storage.test', KV_TOKEN: 'test', isDeno: false, denoKv: null,
    fetch: async (url, opt) => {
      const u = String(url);
      if (u.startsWith('http://whisper.test')) {
        if ((opt && opt.method) === 'POST') {
          const body = opt.body;
          whisper.posts.push({
            language: body.get('language'), modelSize: body.get('modelSize'),
            task: body.get('task'), device: body.get('device'),
            fileName: body.get('file') && body.get('file').name,
            fileSize: body.get('file') && body.get('file').size
          });
          return ok({ id: 'wt1', status: 0 });
        }
        if ((opt && opt.method) === 'DELETE') { whisper.deleted.push(u.split('/').pop()); return ok({ ok: true }); }
        whisper.gets++;
        if (whisper.gets === 1) return ok({ id: 'wt1', status: 1 });
        return ok({ id: 'wt1', status: whisperState.status, result: { text: whisperState.text } });
      }
      if (opt?.method === 'POST') remote = opt.body;
      return ok({ result: remote });
    }
  });
  vm.runInContext(section('function loadData()', 'function topicLabel'), c);
  await c.initStore();
  vm.runInContext(section('// ---------- Comptes famille (V2) ----------', 'function buildSystemPrompt(profile = {})'), c);
  const app = express();
  app.use(express.json());
  for (const [method, ...args] of records) app[method](...args);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const cookie = 'lumi_session=tok';
  const account = { id: 'afam', email: 'parent@example.test', passHash: '', plan: 'free', created: '2026-01-01', settings: { label: 'Famille', maxDevices: 2, dailyLimit: 20 }, usage: {} };
  const d = JSON.parse(remote || '{}');
  d.accounts = { afam: account, local: { id: 'local', plan: 'local', settings: {}, usage: {} } };
  d.sessions = { tok: { accountId: 'afam', expires: '2999-01-01' } };
  await c.setData(d);
  const get = route => fetch(base + route, { headers: { Cookie: cookie } });
  const post = (route, body, withCookie = true) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(withCookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const close = async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); };
  return { c, base, get, post, close, whisper, setWhisper: v => { whisperState = v; } };
}

test('dictée Whisper : statut réservé à la famille connectée, moteur annoncé', async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(f.base + '/api/transcribe/status')).status, 401);
    const j = await (await f.get('/api/transcribe/status')).json();
    assert.deepEqual(j, { available: true, model: 'small', engine: 'whisper' });
  } finally { await f.close(); }
});

test('dictée Whisper : audio envoyé, texte renvoyé, transcription supprimée partout', async () => {
  const f = await fixture();
  try {
    const audio = Buffer.from('faux-audio-enfant').toString('base64');
    const r = await f.post('/api/transcribe', { audio, mime: 'audio/webm;codecs=opus' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, texte: 'bonjour les enfants.' });
    assert.equal(f.whisper.posts.length, 1);
    assert.deepEqual(f.whisper.posts[0], { language: 'fr', modelSize: 'small', task: 'transcribe', device: 'cpu', fileName: 'dictee.webm', fileSize: 17 });
    assert.deepEqual(f.whisper.deleted, ['wt1'], 'la dictée est effacée chez Whishper après lecture');
    const leftovers = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('lumi-dictee-'));
    assert.equal(leftovers.length, 0, 'aucun fichier audio temporaire conservé');
  } finally { await f.close(); }
});

test('dictée Whisper : formats refusés, audio invalide et panne du moteur gérés proprement', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post('/api/transcribe', { audio: 'QUJD', mime: 'audio/flac' })).status, 400);
    assert.equal((await f.post('/api/transcribe', { audio: '!!!pas du base64!!!', mime: 'audio/webm' })).status, 400);
    assert.equal((await f.post('/api/transcribe', { audio: '', mime: 'audio/webm' })).status, 400);
    f.setWhisper({ status: -1, text: '' });
    assert.equal((await f.post('/api/transcribe', { audio: 'QUJD', mime: 'audio/webm' })).status, 502);
    assert.deepEqual(f.whisper.deleted, ['wt1'], 'même en échec, rien ne s’accumule chez Whishper');
  } finally { await f.close(); }
});

test('dictée Whisper : trop de dictées d’un coup = pause (20/minute)', async () => {
  const f = await fixture();
  try {
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (await f.post('/api/transcribe', { audio: 'QUJD', mime: 'audio/webm' })).status;
    }
    assert.equal(last, 429);
  } finally { await f.close(); }
});

test('dictée Whisper : non configurée (Render), tout reste utilisable', async () => {
  const f = await fixture({ RENDER: 'true', WHISPER_API_URL: '' });
  try {
    assert.deepEqual(await (await f.get('/api/transcribe/status')).json(), { available: false, model: 'small', engine: 'whisper' });
    assert.equal((await f.post('/api/transcribe', { audio: 'QUJD', mime: 'audio/webm' })).status, 503);
  } finally { await f.close(); }
});


test('dictée Python sur hébergement : sélection du moteur sans API Whishper, disponibilité et occupation', async () => {
  let busy = false;
  const f = await fixture({ RENDER: 'true', WHISPER_API_URL: '', WHISPER_PYTHON: '/test/python', WHISPER_MODEL_SIZE: 'tiny' }, {
    available: () => true,
    transcribe: async (buffer, ext) => {
      assert.equal(buffer.toString(), 'ABC');
      assert.equal(ext, 'webm');
      if (busy) throw Object.assign(Error('Dictée occupée.'), { status: 429 });
      return 'Bonjour Lumi.';
    }
  });
  try {
    assert.deepEqual(await (await f.get('/api/transcribe/status')).json(), { available: true, model: 'tiny', engine: 'whisper' });
    const r = await f.post('/api/transcribe', { audio: 'QUJD', mime: 'audio/webm' });
    assert.deepEqual(await r.json(), { ok: true, texte: 'Bonjour Lumi.' });
    assert.equal(f.whisper.posts.length, 0);
    busy = true;
    assert.equal((await f.post('/api/transcribe', { audio: 'QUJD', mime: 'audio/webm' })).status, 429);
  } finally { await f.close(); }
});
