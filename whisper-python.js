import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// One inference at a time per Node process on a shared CPU host.
export function createWhisperRunner({ python, script, modelPath, timeoutMs = 75000 }) {
  let active = false;
  const available = () => !!python && !!modelPath && fs.existsSync(python)
    && fs.existsSync(script) && fs.existsSync(path.join(modelPath, 'model.bin'));
  async function transcribe(buffer, extension) {
    if (active) throw Object.assign(Error('La dictée est occupée. Réessaie dans un instant.'), { status: 429 });
    if (!available()) throw Error('Whisper Python indisponible.');
    active = true;
    let folder;
    try {
      folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lumi-dictee-python-'));
      const audio = path.join(folder, 'audio.' + extension);
      await fs.promises.writeFile(audio, buffer, { mode: 0o600 });
      return await new Promise((resolve, reject) => {
        const child = spawn(python, [script, '--model-dir', modelPath, '--audio', audio], {
          stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
          env: { ...process.env, OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2' },
        });
        let output = '', expired = false, oversized = false;
        const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeoutMs);
        child.stdout.on('data', chunk => {
          output += chunk;
          if (output.length > 65536) { oversized = true; child.kill('SIGKILL'); }
        });
        child.once('error', () => { clearTimeout(timer); reject(Error('Whisper Python ne démarre pas.')); });
        child.once('close', code => {
          clearTimeout(timer);
          if (expired) return reject(Error('Transcription trop longue.'));
          if (code !== 0 || oversized) return reject(Error('Transcription impossible.'));
          try {
            const texte = JSON.parse(output).texte;
            if (typeof texte !== 'string' || !texte.trim()) throw Error();
            resolve(texte.trim());
          } catch { reject(Error('Transcription vide ou invalide.')); }
        });
      });
    } finally {
      try { if (folder) await fs.promises.rm(folder, { recursive: true, force: true }); }
      finally { active = false; }
    }
  }
  return { available, transcribe };
}
