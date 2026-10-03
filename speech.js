import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '.lumi-voice');
const binary = path.join(root, 'piper', process.platform === 'win32' ? 'piper.exe' : 'piper');
const model = path.join(root, 'fr_FR-siwis-medium.onnx');
export const speechAvailable = () => existsSync(binary) && existsSync(model) && existsSync(model + '.json');
let tail = Promise.resolve(), waiting = 0;
export function generateSpeech(text) {
  if (!speechAvailable()) return Promise.reject(Object.assign(Error('Voix en cours d’installation.'), { status: 503 }));
  if (waiting >= 4) return Promise.reject(Object.assign(Error('Voix occupée, réessaie dans un instant.'), { status: 429 }));
  waiting++;
  const task = tail.then(async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'lumi-voice-'));
    const wav = path.join(folder, 'voice.wav');
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(binary, ['--model', model, '--output_file', wav], {
          cwd: path.dirname(binary), windowsHide: true,
          env: { ...process.env, OMP_NUM_THREADS: '1' }, stdio: ['pipe', 'ignore', 'ignore'],
        });
        let expired = false;
        const timer = setTimeout(() => { expired = true; child.kill(); }, 60000);
        child.once('error', () => { clearTimeout(timer); reject(Error('Voix indisponible.')); });
        child.once('close', code => {
          clearTimeout(timer);
          if (code !== 0 || expired) reject(Error('La préparation de la voix a échoué.'));
          else resolve();
        });
        child.stdin.on('error', () => {});
        child.stdin.end(String(text).replace(/\r?\n/g, ' ') + '\n');
      });
      const audio = await fs.readFile(wav);
      if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF') throw Error('Audio invalide.');
      return audio;
    } finally { await fs.rm(folder, { recursive: true, force: true }); }
  });
  tail = task.catch(() => {});
  return task.finally(() => { waiting--; });
}
