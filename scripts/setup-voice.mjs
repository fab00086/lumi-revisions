import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// npm ci on Render installs the voice; local developers can run npm run setup:voice.
if (process.argv.includes('--render-only') && !process.env.RENDER) process.exit(0);
if (!['win32', 'linux'].includes(process.platform) || process.arch !== 'x64') throw Error('Voix : plateforme non prise en charge.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.lumi-voice');
await fs.mkdir(root, { recursive: true });
const binary = path.join(root, 'piper', process.platform === 'win32' ? 'piper.exe' : 'piper');
const model = 'fr_FR-siwis-medium.onnx';
async function download(url, name) {
  const target = path.join(root, name);
  try { if ((await fs.stat(target)).size > 0) return; } catch {}
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw Error('Téléchargement voix indisponible : ' + response.status);
  const data = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(target + '.tmp', data);
  await fs.rename(target + '.tmp', target);
}
try { await fs.access(binary); } catch {
  const archive = process.platform === 'win32' ? 'piper_windows_amd64.zip' : 'piper_linux_x86_64.tar.gz';
  await download('https://github.com/rhasspy/piper/releases/download/2023.11.14-2/' + archive, archive);
  const extraction = spawnSync('tar', ['-xf', path.join(root, archive), '-C', root], { windowsHide: true, timeout: 60000 });
  if (extraction.status !== 0) throw Error('Installation de la voix impossible.');
  await fs.access(binary);
}
const base = 'https://huggingface.co/rhasspy/piper-voices/resolve/375a0fe641dea077c2a47b4e9a056d6da521eed3/fr/fr_FR/siwis/medium/';
await download(base + model, model);
await download(base + model + '.json', model + '.json');
await download(base + 'MODEL_CARD', 'MODEL_CARD');
console.log('Voix française Lumi installée.');
