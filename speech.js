import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '.lumi-voice');
const binary = path.join(root, 'piper', process.platform === 'win32' ? 'piper.exe' : 'piper');
const model = path.join(root, 'fr_FR-siwis-medium.onnx');
const edgePython = path.join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const edgeScript = path.join(here, 'scripts', 'edge_say.py');
export const voiceEngine = process.env.VOICE_ENGINE === 'edge' ? 'edge' : 'piper';
export const EDGE_VOICES = {
  vivienne: 'fr-FR-VivienneMultilingualNeural',
  denise: 'fr-FR-DeniseNeural',
  eloise: 'fr-FR-EloiseNeural',
  sylvie: 'fr-CA-SylvieNeural',
};
const edgeVoice = process.env.EDGE_VOICE || EDGE_VOICES.vivienne;
export const speechAvailable = () => voiceEngine === 'edge'
  ? existsSync(edgePython) && existsSync(edgeScript)
  : existsSync(binary) && existsSync(model) && existsSync(model + '.json');
let tail = Promise.resolve(), waiting = 0;
let worker = null, pending = null;
export function closeSpeechWorker() {
  const child = worker; worker = null;
  if (pending?.child === child) { const job=pending; pending=null; clearTimeout(job.timer); job.reject(Error('Voix interrompue.')); }
  child?.kill();
}
function speechWorker() {
  if (worker) return worker;
  const child = spawn(binary, ['--model', model, '--json-input'], {
    cwd: path.dirname(binary), windowsHide: true,
    env: { ...process.env, OMP_NUM_THREADS: '1' }, stdio: ['pipe', 'pipe', 'ignore'],
  });
  worker = child;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const job = pending;
    if (job?.child !== child || line.trim() !== job.wav) return;
    pending = null; clearTimeout(job.timer); job.resolve();
  });
  const failed = () => {
    child.kill();
    if (worker === child) worker = null;
    const job = pending;
    if (job?.child === child) { pending=null; clearTimeout(job.timer); job.reject(Error('La préparation de la voix a échoué.')); }
    lines.close();
  };
  child.once('error', failed); child.once('close', failed);
  child.stdin.on('error', failed);
  return child;
}
process.once('exit', () => worker?.kill());
function edgeSpeech(text, wav, voiceName) {
  return new Promise((resolve, reject) => {
    const child = spawn(edgePython, [edgeScript, '--voice', voiceName, '--text', String(text).replace(/\r?\n/g, ' '), '--out', wav], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let details = '';
    child.stderr.on('data', data => { details += data.toString(); if (details.length > 4000) details = details.slice(-4000); });
    const timer = setTimeout(() => { child.kill(); reject(Error('Voix : délai dépassé.')); }, 45000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(Error('Voix edge : ' + (details.trim().slice(-200) || 'échec')));
    });
  });
}
let samplePromise = null, sampleRetryAt = 0;
export function generateSpeechSample() {
  if (samplePromise) return samplePromise;
  if (Date.now() < sampleRetryAt) return Promise.reject(Error('Test vocal indisponible. Réessaie dans une minute.'));
  samplePromise = generateSpeech('Bonjour. Je suis Lumi. Est-ce que tu entends ma voix ?').catch(error => {
    samplePromise = null; sampleRetryAt = Date.now() + 60000; throw error;
  });
  return samplePromise;
}
export function generateSpeech(text, voice) {
  if (!speechAvailable()) return Promise.reject(Object.assign(Error('Voix en cours d’installation.'), { status: 503 }));
  if (waiting >= 4) return Promise.reject(Object.assign(Error('Voix occupée, réessaie dans un instant.'), { status: 429 }));
  const voiceName = EDGE_VOICES[String(voice || '').trim().toLowerCase()] || edgeVoice;
  waiting++;
  const task = tail.then(async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'lumi-voice-'));
    const wav = path.join(folder, 'voice.wav');
    try {
      if (voiceEngine === 'edge') {
        await edgeSpeech(text, wav, voiceName);
      } else {
        await new Promise((resolve, reject) => {
          const child = speechWorker();
          const timer = setTimeout(() => closeSpeechWorker(), 60000);
          pending = { child, wav, resolve, reject, timer };
          child.stdin.write(JSON.stringify({ text: String(text).replace(/\r?\n/g, ' '), output_file: wav }) + '\n');
        });
      }
      const audio = await fs.readFile(wav);
      if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF') throw Error('Audio invalide.');
      return audio;
    } finally { await fs.rm(folder, { recursive: true, force: true }); }
  });
  tail = task.catch(() => {});
  return task.finally(() => { waiting--; });
}
