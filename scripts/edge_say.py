#!/usr/bin/env python3
"""Synthèse edge-tts -> WAV PCM 16 bits pour Lumi (sans ffmpeg).

Deux modes :
- ponctuel : --voice ... --text ... --out ...
- persistent (--worker) : une demande JSON par ligne sur l'entrée standard,
  {"voice": "...", "text": "...", "out": "..."} ; répond sur la sortie standard
  le chemin produit, ou « ERROR ... » en cas d'échec. Le processus reste chaud :
  python et edge_tts ne sont plus rechargés à chaque phrase (le premier appel
  après un redémarrage coûtait plusieurs secondes, toutes voix confondues).
"""
import argparse, asyncio, io, json, sys
import edge_tts
import soundfile as sf

async def synth(voice, text, out):
    communicate = edge_tts.Communicate(text, voice)
    mp3 = bytearray()
    async for chunk in communicate.stream():
        if chunk.get("type") == "audio" and chunk.get("data"):
            mp3.extend(chunk["data"])
    if len(mp3) < 100:
        raise RuntimeError("edge-tts : aucun audio reçu")
    data, rate = sf.read(io.BytesIO(bytes(mp3)), dtype="int16", always_2d=False)
    sf.write(out, data, rate, subtype="PCM_16")

def worker():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
            voice = str(job.get("voice") or "")
            text = str(job.get("text") or "")
            out = str(job.get("out") or "")
            asyncio.run(synth(voice, text, out))
            print(out, flush=True)
        except Exception as error:
            print("ERROR " + str(error).replace("\n", " ")[:300], flush=True)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--voice")
    parser.add_argument("--text")
    parser.add_argument("--out")
    parser.add_argument("--worker", action="store_true")
    args = parser.parse_args()
    if args.worker:
        worker()
        return
    if not (args.voice and args.text and args.out):
        print("Arguments manquants.", file=sys.stderr)
        sys.exit(2)
    try:
        asyncio.run(synth(args.voice, args.text, args.out))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
