#!/usr/bin/env bash
# Скачивает модели: whisper (распознавание) и голос Piper (озвучка).
# WHISPER_MODEL=base|small (small точнее, но медленнее на слабом CPU). VOICE=irina|ruslan|denis|dmitri
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
WHISPER_MODEL="${WHISPER_MODEL:-base}"
VOICE="${VOICE:-irina}"
mkdir -p models/whisper models/voices

w="models/whisper/ggml-${WHISPER_MODEL}.bin"
if [ ! -s "$w" ]; then
  echo "==> whisper $WHISPER_MODEL"
  curl -fL --progress-bar -o "$w.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin" && mv "$w.part" "$w"
fi

base="https://huggingface.co/rhasspy/piper-voices/resolve/main/ru/ru_RU/${VOICE}/medium"
for f in "ru_RU-${VOICE}-medium.onnx" "ru_RU-${VOICE}-medium.onnx.json"; do
  if [ ! -s "models/voices/$f" ]; then
    echo "==> голос $f"
    curl -fL --progress-bar -o "models/voices/$f.part" "$base/$f" && mv "models/voices/$f.part" "models/voices/$f"
  fi
done
echo "Модели на месте."
