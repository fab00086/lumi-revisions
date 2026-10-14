#!/usr/bin/env python3
"""Synthèse edge-tts -> WAV PCM 16 bits pour Lumi (sans ffmpeg)."""
import argparse, asyncio, io, sys
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

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--voice", required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    try:
        asyncio.run(synth(args.voice, args.text, args.out))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
