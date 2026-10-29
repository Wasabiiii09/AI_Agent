#!/usr/bin/env bash
# Запуск компаньона (Wayland-native). В hyprland.conf: exec-once = ~/anime-companion/bin/run.sh
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
export ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-wayland}"
# piper / faster-whisper из локального venv
[ -d .venv/bin ] && export PATH="$PWD/.venv/bin:$PATH"
EXTRA=()
# Если окно не прозрачное или ошибка GPU на слабом ноуте — попробуй COMPANION_NO_GPU=1
[ "${COMPANION_NO_GPU:-0}" = "1" ] && EXTRA+=(--disable-gpu)
mkdir -p "${XDG_STATE_HOME:-$HOME/.local/state}"
exec ./node_modules/.bin/electron . --ozone-platform=wayland --enable-features=UseOzonePlatform "${EXTRA[@]}" "$@" >> "${XDG_STATE_HOME:-$HOME/.local/state}/anime-companion.log" 2>&1
