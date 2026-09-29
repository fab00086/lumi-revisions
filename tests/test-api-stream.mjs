// Test STREAMING de l'API : ou arrive le raisonnement dans delta ?
import 'dotenv/config';
const BASE = (process.env.OLLAMA_BASE_URL || 'https://ollama.com').replace(/\/+$/, '');
const KEY = process.env.OLLAMA_API_KEY || '';
const MODEL = process.env.OLLAMA_MODEL || 'glm-5.3-flash:cloud';

async function tryStream(label, extra) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      messages: [
        { role: 'system', content: 'Tu es Lumi, un tuteur pour enfant de 9 ans. Reponds en francais en 3 phrases courtes maximum.' },
        { role: 'user', content: 'Pourquoi la Lune change de forme dans le ciel ?' }
      ],
      max_tokens: 700,
      ...extra
    }),
    signal: AbortSignal.timeout(90000)
  });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', content = '', reasoning = '', lastUsage = null, finish = '';
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
        const d = j.choices?.[0]?.delta || {};
        if (d.content) content += d.content;
        if (d.reasoning || d.reasoning_content) reasoning += (d.reasoning || d.reasoning_content);
        if (j.usage) lastUsage = j.usage;
        if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
      } catch {}
    }
  }
  console.log('=== ' + label + ' ===');
  console.log('finish:', finish, '| usage:', JSON.stringify(lastUsage));
  console.log('content[' + content.length + ']:', JSON.stringify(content.slice(0, 250)));
  console.log('reasoning[' + reasoning.length + ']:', JSON.stringify(reasoning.slice(0, 150)));
  console.log('---');
}

await tryStream('S1. stream baseline');
await tryStream('S2. stream + reasoning_effort low', { reasoning_effort: 'low' });
await tryStream('S3. stream + think false', { think: false });