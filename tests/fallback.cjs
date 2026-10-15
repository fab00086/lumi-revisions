// IA de secours : surcharge (429), panne (5xx) ou reseau/timeout du modele
// principal -> une seule re-test sur le modele de secours, puis erreur claire.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function section(a, b) { const start = source.indexOf(a), end = source.indexOf(b, start); assert.ok(start >= 0 && end > start, 'section introuvable : ' + a); return source.slice(start, end); }
function ctxAppel(fetchMock, env = {}) {
  return vm.createContext({
    console, TextDecoder, AbortSignal, Buffer,
    envVars: { OLLAMA_FALLBACK_MODEL: env.fallback ?? 'secours:cloud' },
    process: { env: { OLLAMA_FALLBACK_MODEL: env.fallback ?? 'secours:cloud' } },
    BASE_URL: 'http://ia.test', API_KEY: 'cle-test',
    MODEL: env.model || 'principal', VISION_MODEL: env.vision || 'vision',
    REASONING_EFFORT: 'low', REPLY_TOKENS: 4096, PHOTO_TOKENS: 4096,
    fetch: fetchMock
  });
}
let appels = [];
function fetchJete() {
  appels = [];
  return async (url, opt) => { appels.push(JSON.parse(opt.body)); throw Object.assign(new Error('fetch failed'), { name: 'TypeError' }); };
}
function repondre(status, contenu) {
  appels = [];
  return async (url, opt) => {
    const body = JSON.parse(opt.body);
    appels.push(body);
    const st = (typeof status === 'function') ? status(appels.length) : status;
    if (st !== 200) return { ok: false, status: st, text: async () => 'overloaded' };
    return { ok: true, json: async () => ({ choices: [{ message: { content: contenu }, finish_reason: 'stop' }] }) };
  };
}

test('callOllama : surcharge 429 du principal -> bascule sur le modele de secours', async () => {
  const c = ctxAppel(repondre(n => n === 1 ? 429 : 200, 'bonjour'));
  vm.runInContext(section('const REPLY_TOKENS = 4096;', '// Bilan pedagogique'), c);
  const r = await c.callOllama([{ role: 'user', content: 'salut' }]);
  assert.equal(r.content, 'bonjour');
  assert.equal(appels.length, 2);
  assert.equal(appels[0].model, 'principal');
  assert.equal(appels[1].model, 'secours:cloud');
  // Le secours n'est pas forcement un modele "raisonneur" : sans options etrangeres
  assert.equal(appels[0].reasoning_effort, 'low');
  assert.ok(!('reasoning_effort' in appels[1]));
});

test('callOllama : erreur 500/503 -> bascule ; 400 -> pas de bascule', async () => {
  const c = ctxAppel(repondre(n => n === 1 ? 503 : 200, 'ok'));
  vm.runInContext(section('const REPLY_TOKENS = 4096;', '// Bilan pedagogique'), c);
  assert.equal((await c.callOllama([{ role: 'user', content: 'x' }])).content, 'ok');
  assert.equal(appels[1].model, 'secours:cloud');

  const c2 = ctxAppel(repondre(400, ''));
  vm.runInContext(section('const REPLY_TOKENS = 4096;', '// Bilan pedagogique'), c2);
  await assert.rejects(() => c2.callOllama([{ role: 'user', content: 'x' }]), /Ollama 400/);
  assert.equal(appels.length, 1, 'un 400 ne recommence pas sur un autre modele');
});

test('callOllama : timeout/reseau -> bascule ; sans secours configure -> erreur directe', async () => {
  const c = ctxAppel(fetchJete());
  vm.runInContext(section('const REPLY_TOKENS = 4096;', '// Bilan pedagogique'), c);
  await assert.rejects(() => c.callOllama([{ role: 'user', content: 'x' }]), /fetch failed|Le service IA/u);
  assert.equal(appels.length, 2, 'reseau en panne : le secours est tente, puis l\'erreur sort');

  const c2 = ctxAppel(repondre(n => n === 1 ? 429 : 200, 'ok'), { fallback: '' });
  vm.runInContext(section('const REPLY_TOKENS = 4096;', '// Bilan pedagogique'), c2);
  await assert.rejects(() => c2.callOllama([{ role: 'user', content: 'x' }]), /Le service IA est momentanément/u);
  assert.equal(appels.length, 1);
});

test('callOllama : une photo ne bascule JAMAIS sur le modele de secours (texte)', async () => {
  const c = ctxAppel(repondre(429, ''));
  vm.runInContext(section('const REPLY_TOKENS = 4096;', '// Bilan pedagogique'), c);
  await assert.rejects(() => c.callOllama([{ role: 'user', content: 'lis mon cahier' }], { image: 'QUJD' }), /Le service IA est momentanément/);
  assert.equal(appels.length, 1, 'une seule tentative : le modele vision');
  assert.equal(appels[0].model, 'vision', 'le secours texte ne recoit jamais une image');
});

test('streamOllama : 503 avant le premier mot -> bascule sur le secours et diffusion', async () => {
  appels = [];
  const enc = new TextEncoder();
  let n = 0;
  const c = vm.createContext({
    console, TextDecoder, AbortSignal, Buffer, BASE_URL: 'http://ia.test', API_KEY: 'cle-test',
    MODEL: 'principal', VISION_MODEL: 'vision', REASONING_EFFORT: 'low', REPLY_TOKENS: 4096, PHOTO_TOKENS: 4096,
    FALLBACK_MODEL: 'secours:cloud',
    fetch: async (url, opt) => {
      const body = JSON.parse(opt.body);
      appels.push(body);
      if (++n === 1) return { ok: false, status: 503, text: async () => 'overloaded' };
      return { ok: true, body: new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Cou"}}]}\n\n'));
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"cou Lumi"}}]}\n\n'));
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          controller.close();
        }
      }) };
    }
  });
  vm.runInContext(section('async function streamOllama(', '// Conserve le début'), c);
  let full = '';
  const texte = await c.streamOllama([{ role: 'user', content: 'salut' }], { onDelta: (d, f) => { full = f; } });
  assert.equal(texte, 'Coucou Lumi');
  assert.equal(appels[0].model, 'principal');
  assert.equal(appels[1].model, 'secours:cloud');
});