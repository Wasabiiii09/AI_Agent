#!/usr/bin/env bash
# Установка на Arch Linux (Hyprland). Запускать из папки проекта: ./scripts/install-arch.sh
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."

echo "==> Пакеты pacman (нужен sudo)"
sudo pacman -S --needed --noconfirm \
  nodejs npm python uv git cmake base-devel \
  pipewire wireplumber pipewire-pulse \
  playerctl grim slurp xdg-utils libnotify noto-fonts noto-fonts-emoji

echo "==> Node-зависимости (Electron, three.js, three-vrm)"
npm install --no-fund --no-audit

echo "==> Python venv с Piper TTS (Python 3.12 через uv, чтобы были готовые колёса)"
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python piper-tts
if [ "${WITH_FASTER_WHISPER:-0}" = "1" ]; then uv pip install --python .venv/bin/python faster-whisper; fi

echo "==> Сборка whisper.cpp (CPU)"
if [ ! -x vendor/whisper.cpp/build/bin/whisper-cli ]; then
  mkdir -p vendor
  [ -d vendor/whisper.cpp ] || git clone --depth 1 https://github.com/ggml-org/whisper.cpp vendor/whisper.cpp
  cmake -S vendor/whisper.cpp -B vendor/whisper.cpp/build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF
  cmake --build vendor/whisper.cpp/build -j"$(nproc)" --config Release --target whisper-cli
fi

./scripts/download-models.sh

[ -f .env ] || { cp .env.example .env; echo "==> Создан .env — впиши туда XAI_API_KEY"; }
chmod +x bin/run.sh bin/companion-ctl
echo
echo "Готово. Дальше: впиши ключ в .env, добавь строки из hyprland/companion.conf в ~/.config/hypr/hyprland.conf, запусти bin/run.sh"
echo "Проверка: node bin/doctor.js"
