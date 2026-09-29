// Test direct de l'API Ollama cloud : comment obtenir une reponse propre
// (sans raisonnement fuyant) de glm-5.3-flash ?
import 'dotenv/config';
const BASE = (process.env.OLLAMA_BASE_URL || 'https://ollama.com').replace(/\/+$/, '');
const KEY = process.env.OLLAMA_API_KEY || '';
const MODEL = process.env.OLLAMA_MODEL || 'glm-5.3-flash:cloud';

async function tryCall(label, extra) {
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: 'Tu es Lumi, un tuteur pour enfant de 9 ans. Reponds en francais en 3 phrases courtes maximum.' },
          { role: 'user', content: 'Pourquoi la Lune change de forme dans le ciel ?' }
        ],
        max_tokens: 700,
        ...extra
      }),
      signal: AbortSignal.timeout(60000)
    });
    const j = await r.json();
    const m = j.choices?.[0] || {};
    const content = String(m.message?.content || '');
    const reasoning = String(m.message?.reasoning || '');
    console.log('=== ' + label + ' ===');
    console.log('finish_reason:', m.finish_reason, '| usage:', JSON.stringify(j.usage || {}));
    console.log('content [' + content.length + ']:', JSON.stringify(content.slice(0, 300)));
    if (reasoning) console.log('reasoning [' + reasoning.length + ']:', JSON.stringify(reasoning.slice(0, 120)));
    console.log('---');
  } catch (e) {
    console.log('=== ' + label + ' === ERREUR: ' + e.message + '\n---');
  }
}

await tryCall('1. baseline (rien)');
await tryCall('2. reasoning_effort none', { reasoning_effort: 'none' });
await tryCall('3. reasoning_effort low', { reasoning_effort: 'low' });
await tryCall('4. think false', { think: false });