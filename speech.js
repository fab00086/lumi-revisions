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
// Voix par defaut : vivienne (choix de la famille). Le cout "a froid" du
// PREMIER appel (~5 s apres un redemarrage, cache systeme vide) ne vient pas
// d'elle : python est relance a chaque synthese (edgeSpeech). D'ou le
// rechauffage : generateSpeechSample() au demarrage + warmEdgeVoice() en
// entretien (import python seul, sans reseau).
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
// Worker edge PERSISTANT : python et edge_tts restent charges entre les
// phrases. Avant, chaque synthese relancait python (~1 a plusieurs secondes a
// froid, surtout juste apres un redemarrage) — d'ou les « reponses trop
// longues » alors que la voix elle-meme est rapide (1,2 s a chaud).
let edgeWorker = null, edgeJob = null;
function edgeWorkerProcess() {
  if (edgeWorker) return edgeWorker;
  const child = spawn(edgePython, [edgeScript, '--worker'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  edgeWorker = child;
  let stderrTail = '';
  child.stderr.on('data', data => { stderrTail += data.toString(); if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const job = edgeJob;
    if (!job || job.child !== child) return;
    const t = line.trim();
    if (t === job.wav) { edgeJob = null; clearTimeout(job.timer); job.resolve(); return; }
    if (t.startsWith('ERROR')) { edgeJob = null; clearTimeout(job.timer); job.reject(Error('Voix edge : ' + (t.slice(5).trim().slice(-200) || 'échec'))); }
  });
  const failed = () => {
    try { child.kill(); } catch {}
    if (edgeWorker === child) edgeWorker = null;
    const job = edgeJob;
    if (job && job.child === child) {
      edgeJob = null; clearTimeout(job.timer);
      job.reject(Object.assign(Error('Voix interrompue pendant la préparation.'), { workerDown: true, details: stderrTail.trim().slice(-200) }));
    }
    try { lines.close(); } catch {}
  };
  child.once('error', failed); child.once('close', failed); child.stdin.on('error', failed);
  return child;
}
process.once('exit', () => { try { edgeWorker?.kill(); } catch {} });
function edgeSpeechWorker(text, wav, voiceName) {
  return new Promise((resolve, reject) => {
    const child = edgeWorkerProcess();
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(Object.assign(Error('Voix : délai dépassé.'), { workerDown: true }));
    }, 45000);
    edgeJob = { child, wav, resolve, reject, timer };
    try { child.stdin.write(JSON.stringify({ voice: voiceName, text, out: wav }) + '\n'); }
    catch { edgeJob = null; clearTimeout(timer); reject(Object.assign(Error('Voix interrompue.'), { workerDown: true })); }
  });
}
// Repli ponctuel (ancien comportement) : un python neuf si le worker est tombe.
function edgeSpeechOnce(text, wav, voiceName) {
  return new Promise((resolve, reject) => {
    const child = spawn(edgePython, [edgeScript, '--voice', voiceName, '--text', text, '--out', wav], {
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
function edgeSpeech(text, wav, voiceName) {
  const clean = String(text).replace(/\r?\n/g, ' ');
  return edgeSpeechWorker(clean, wav, voiceName).catch(error => {
    if (error && error.workerDown) return edgeSpeechOnce(clean, wav, voiceName);
    throw error;
  });
}
let samplePromise = null, sampleRetryAt = 0;
export function generateSpeechSample() {
  if (samplePromise) return samplePromise;
  if (Date.now() < sampleRetryAt) return Promise.reject(Error('Test vocal indisponible. Réessaie dans une minute.'));
  samplePromise = generateSpeech('Bonjour. Je suis Savika. Est-ce que tu entends ma voix ?').catch(error => {
    samplePromise = null; sampleRetryAt = Date.now() + 60000; throw error;
  });
  return samplePromise;
}
export function generateSpeech(text, voice) {
  if (!speechAvailable()) return Promise.reject(Object.assign(Error('Voix en cours d’installation.'), { status: 503 }));
  if (waiting >= 4) return Promise.reject(Object.assign(Error('Voix occupée, réessaie dans un instant.'), { status: 429 }));
  const voiceName = EDGE_VOICES[String(voice || '').trim().toLowerCase()] || edgeVoice;
  const t0 = Date.now();
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
      console.log(`  [voix] ${String(voice || 'defaut')} : ${Date.now() - t0} ms (${audio.length} octets)`);
      return audio;
    } finally { await fs.rm(folder, { recursive: true, force: true }); }
  });
  tail = task.catch(() => {});
  return task.finally(() => { waiting--; });
}

// Garde le chemin edge pret : demarre le worker persistant si besoin (sans
// synthese reseau). Le worker reste chaud tant que le serveur vit.
export function warmEdgeVoice() {
  if (voiceEngine !== 'edge') return Promise.resolve();
  try { edgeWorkerProcess(); } catch {}
  return Promise.resolve();
}
