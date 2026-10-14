"""Local CPU transcription: no network calls, no saved audio or transcript."""
import argparse
import json
import sys

import av
import numpy as np
from faster_whisper import WhisperModel


def read_short_audio(filename):
    chunks = []
    samples = 0
    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    with av.open(filename) as container:
        for frame in container.decode(audio=0):
            for converted in resampler.resample(frame):
                samples += converted.samples
                if samples > 20 * 16000:
                    raise ValueError("Audio exceeds twenty seconds")
                chunks.append(converted.to_ndarray().reshape(-1))
        for converted in resampler.resample(None):
            samples += converted.samples
            if samples > 20 * 16000:
                raise ValueError("Audio exceeds twenty seconds")
            chunks.append(converted.to_ndarray().reshape(-1))
    if not samples:
        raise ValueError("Empty audio")
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model-dir", required=True)
    args = parser.parse_args()
    audio = read_short_audio(args.audio)
    model = WhisperModel(args.model_dir, device="cpu", compute_type="int8",
                         cpu_threads=2, num_workers=1, local_files_only=True)
    segments, _ = model.transcribe(audio, language="fr", beam_size=5,
                                   condition_on_previous_text=False, vad_filter=True)
    text = " ".join(segment.text.strip() for segment in segments).strip()
    if not text:
        raise ValueError("No speech")
    print(json.dumps({"texte": text}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Whisper transcription failed", file=sys.stderr)
        sys.exit(1)
