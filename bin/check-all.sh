#!/usr/bin/env bash
echo "=== 1. Проверка окружения и конфигурации ==="
[ -f .env ] && echo "✔ Файл .env найден" || echo "✘ Файл .env отсутствует!"
grep -q "XAI_API_KEY=.*[^[:space:]]" .env && echo "✔ XAI_API_KEY заполнен" || echo "✘ XAI_API_KEY пустой или не задан!"

echo -e "\n=== 2. Проверка моделей и бинарников ==="
[ -f models/marin.vrm ] && echo "✔ Модель marin.vrm на месте" || echo "✘ Нет models/marin.vrm"
[ -f models/whisper/ggml-base.bin ] && echo "✔ Whisper модель на месте" || echo "✘ Нет models/whisper/ggml-base.bin"
[ -f models/voices/ru_RU-irina-medium.onnx ] && echo "✔ Голос piper на месте" || echo "✘ Нет файлов голоса piper"
[ -f bin/whisper-cli ] && echo "✔ whisper-cli собран" || echo "✘ whisper-cli не найден в bin/"
[ -x .venv/bin/piper ] && echo "✔ piper установлен в .venv" || echo "✘ piper не найден в .venv"

echo -e "\n=== 3. Проверка Electron ==="
if node -e "require('./node_modules/electron')" 2>/dev/null; then
    echo "✔ Electron установлен и готов к работе"
else
    echo "✘ Electron поврежден или не установлен"
fi

echo -e "\n=== 4. Последние ошибки из логов ==="
if [ -f ~/.local/state/anime-companion.log ]; then
    tail -n 5 ~/.local/state/anime-companion.log
else
    echo "Лог-файл пока пуст (приложение еще не писало в него)"
fi
