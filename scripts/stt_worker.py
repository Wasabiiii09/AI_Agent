#!/usr/bin/env python3
"""Persistent faster-whisper worker: reads {"wav": path} JSON lines, writes {"text": ...}."""
import argparse, json, sys, wave

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("--model", default="base")
ap.add_argument("--language", default="ru")
ap.add_argument("--threads", type=int, default=4)
ap.add_argument("--compute", default="int8")
a = ap.parse_args()

from faster_whisper import WhisperModel  # noqa: E402

model = WhisperModel(a.model, device="cpu", compute_type=a.compute, cpu_threads=a.threads)


def load_audio(path):
    """16 kHz mono s16 WAV (what the recorder writes) -> float32 array; avoids PyAV decoding."""
    try:
        with wave.open(path, "rb") as w:
            if w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2:
                return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    except wave.Error:
        pass
    return path  # let faster-whisper decode other formats


for line in sys.stdin:
    try:
        req = json.loads(line)
        segs, _ = model.transcribe(load_audio(req["wav"]), language=a.language, beam_size=1, vad_filter=True)
        print(json.dumps({"text": " ".join(s.text.strip() for s in segs)}, ensure_ascii=False), flush=True)
    except Exception as e:  # keep worker alive
        print(json.dumps({"error": str(e)}), flush=True)
