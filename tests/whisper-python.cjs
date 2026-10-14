const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function fixture(code, timeoutMs = 5000) {
  const { createWhisperRunner } = await import('../whisper-python.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumi-whisper-test-'));
  const script = path.join(root, 'fake.cjs');
  await fs.writeFile(script, code);
  await fs.writeFile(path.join(root, 'model.bin'), 'fixture');
  const runner = createWhisperRunner({ python: process.execPath, script, modelPath: root, timeoutMs });
  return { root, runner, close: () => fs.rm(root, { recursive: true, force: true }) };
}

test('Python runner removes audio after successful transcription', async () => {
  const f = await fixture(`const fs=require('node:fs'); const audio=process.argv.at(-1);
    if(fs.readFileSync(audio).toString()!=='ABC') process.exit(2);
    console.log(JSON.stringify({texte:audio}));`);
  try {
    assert.equal(f.runner.available(), true);
    const audio = await f.runner.transcribe(Buffer.from('ABC'), 'webm');
    await assert.rejects(fs.stat(audio), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.dirname(audio)), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('Python runner cleans failed requests and can be used again', async () => {
  const f = await fixture('process.exit(1);');
  try {
    const pathFile = path.join(f.root, 'audio-path');
    await fs.writeFile(path.join(f.root, 'fake.cjs'), `const fs=require('node:fs');
      fs.writeFileSync(${JSON.stringify(pathFile)},process.argv.at(-1)); console.log('invalid JSON');`);
    await assert.rejects(f.runner.transcribe(Buffer.from('ABC'), 'wav'), /invalide/);
    const audio = await fs.readFile(pathFile, 'utf8');
    await assert.rejects(fs.stat(path.dirname(audio)), { code: 'ENOENT' });
    await fs.writeFile(path.join(f.root, 'fake.cjs'), `console.log(JSON.stringify({texte:'Bonjour'}));`);
    assert.equal(await f.runner.transcribe(Buffer.from('ABC'), 'wav'), 'Bonjour');
  } finally { await f.close(); }
});

test('Python runner times out and rejects simultaneous inference', async () => {
  const f = await fixture('setInterval(()=>{},1000);', 200);
  try {
    const pending = assert.rejects(f.runner.transcribe(Buffer.from('ABC'), 'wav'), /trop longue/);
    await assert.rejects(f.runner.transcribe(Buffer.from('ABC'), 'wav'), { status: 429 });
    await pending;
    await fs.writeFile(path.join(f.root, 'fake.cjs'), `console.log(JSON.stringify({texte:'Prêt'}));`);
    assert.equal(await f.runner.transcribe(Buffer.from('ABC'), 'wav'), 'Prêt');
  } finally { await f.close(); }
});
