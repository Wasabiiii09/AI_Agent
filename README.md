# Anime Companion — аниме-компаньон для Arch Linux + Hyprland

3D аниме-девушка (VRM) в прозрачном окне поверх рабочего стола. Слушает микрофон по горячей клавише, думает через ИИ (по умолчанию Grok 4.3), **отвечает голосом** и умеет выполнять команды: открыть программу или сайт, музыка, громкость, скриншот, поиск файлов, время, таймер. Опасное (удаление, sudo и т.п.) — только после «да».

Голос и распознавание речи работают **локально и бесплатно** (Piper + whisper.cpp на процессоре, видеокарта не нужна). Платишь только за «мозг».

## Что внутри

```
anime-companion/
├─ bin/
│  ├─ run.sh              запуск (Wayland-native Electron)
│  ├─ companion-ctl       команды для хоткеев Hyprland (говорить, режимы, персонаж…)
│  └─ doctor.js           проверка, всё ли установлено
├─ config.json            все настройки: персонажи, мозг, голос, программы, разрешённые команды
├─ .env.example           шаблон для API-ключа
├─ hyprland/companion.conf  правила окна + хоткеи для hyprland.conf
├─ models/                сюда кладутся .vrm, голоса Piper и модель whisper
├─ scripts/
│  ├─ install-arch.sh     установка всего на Arch
│  ├─ download-models.sh  скачать голос и модель распознавания
│  └─ stt_worker.py       (опц.) faster-whisper вместо whisper.cpp
├─ src/main/              Electron: ИИ, инструменты, голос, микрофон, сокет управления
├─ src/renderer/          окно: three.js + three-vrm, моргание, дыхание, синхронизация губ
└─ test/                  тесты (npm test)
```

## Установка (Arch Linux)

```bash
# 1. распакуй архив в домашнюю папку
cd ~ && unzip anime-companion.zip && cd anime-companion

# 2. всё ставится одним скриптом (pacman + npm + venv с Piper + сборка whisper.cpp + модели)
bash scripts/install-arch.sh
```

Скрипт ставит через pacman: `nodejs npm python uv git cmake base-devel pipewire wireplumber pipewire-pulse playerctl grim slurp xdg-utils libnotify noto-fonts noto-fonts-emoji`.
AUR (yay) не нужен. Piper ставится в локальный `.venv` (пакет `piper` в репозиториях Arch — это другая программа, для мышек!).

```bash
# 3. ключ API
nano .env              # впиши XAI_API_KEY=... (https://console.x.ai -> API Keys)

# 4. модель персонажа — см. раздел «Модели» ниже, положи файл в models/marin.vrm

# 5. проверка
node bin/doctor.js            # что установлено / чего не хватает
node bin/doctor.js --speak    # услышать её голос
node bin/doctor.js --llm      # тестовый запрос к ИИ (тратит доли цента)
```

### 6. Hyprland

Добавь в `~/.config/hypr/hyprland.conf`:

```
source = ~/anime-companion/hyprland/companion.conf
```

и перезагрузи конфиг (`hyprctl reload`) или перелогинься. В файле уже есть:

| Клавиши | Что делает |
|---|---|
| **держи Super+Z** | говори; отпустила клавишу — она распознаёт и отвечает |
| Super+Shift+Z | режим «кликабельно» (поле ввода текста, кнопки Да/Нет) ↔ «клики проходят сквозь» |
| Super+Alt+Z | спрятать / показать |
| Super+Ctrl+Z | замолчать |

Правила окна написаны в **новом синтаксисе** `windowrule = match:title ..., float on, pin on, …` (Hyprland 0.53+). Для старого Hyprland там же есть закомментированные строки `windowrulev2`. Версию смотри: `hyprctl version`.

Запуск вручную: `bin/run.sh` (лог: `~/.local/state/anime-companion.log`). Автозапуск уже есть в companion.conf (`exec-once`).

### Команды без хоткеев

```bash
bin/companion-ctl say "открой браузер"     # написать ей текстом
bin/companion-ctl yes | no                 # подтвердить / отменить опасное действие
bin/companion-ctl character                # список персонажей
bin/companion-ctl character ruby           # переключить персонажа на лету
bin/companion-ctl reset                    # забыть разговор
bin/companion-ctl status                   # состояние и сколько токенов потрачено
bin/companion-ctl ptt-toggle               # вкл/выкл микрофон (если удобнее нажимать, а не держать)
```

## Модели (.vrm) и персонажи

В `config.json` → `characters` есть персонажи, у каждого свои модель, характер и голос:

| Ключ | Модель | Голос | Файл |
|---|---|---|---|
| `marin` (по умолчанию) | Марин | `piper` (Ирина) | `models/marin.vrm` |
| `ruby` | Руби | `piper-ruby` (Ирина, быстрее и живее) | `models/ruby.vrm` |
| `default` | любая | `piper` | `models/avatar.vrm` |

Активный персонаж — `"activeCharacter": "marin"`, или на лету `bin/companion-ctl character ruby`. Своего персонажа добавить просто: скопируй блок в `characters`, поменяй `vrm`, `persona.name`, `persona.style`, `persona.greeting`, `tts`.

### ⚠ Про выбранные модели с VRoid Hub

Обе выбранные модели **нельзя скачать** — авторы выставили «только просмотр на VRoid Hub», кнопки Download на страницах нет:

- **Marin Kitagawa** (автор Kitzoomer) — https://hub.vroid.com/characters/3340757246803872885/models/5869041885565467731
  Скачивание: запрещено. Использование другими: запрещено (только автор). Изменение и распространение: запрещены. Коммерческое использование: запрещено. Указывать автора: обязательно.
- **星野ルビー / Ruby Hoshino, 制服ver** (автор Mujo Moroyuki) — https://hub.vroid.com/characters/2957362284113249551/models/8283653689728616255
  Скачивание: запрещено. Использование другими: запрещено (только просмотр). Распространение: запрещено. Коммерческое: только некоммерческое личное (у корпораций — нет). В описании автор пишет, что менять модель можно, просит указывать авторство, а распространять модель и вытаскивать из неё одежду, причёски и текстуры запрещено.

Обе — фан-модели персонажей из аниме («Эта фарфоровая кукла влюбилась» и «Звёздное дитя»), то есть годятся максимум для личного использования.

Что можно сделать:
1. **Сделать свою Марин или Руби в VRoid Studio** (бесплатно, https://vroid.com/studio): похожие волосы, глаза и одежда, затем *Экспорт → VRM* и сохранить как `models/marin.vrm` / `models/ruby.vrm`. Самый надёжный вариант.
2. **Найти похожую модель, которую можно скачать:** на https://hub.vroid.com ищи по имени (`Marin Kitagawa`, `Ruby Hoshino`) и открывай модели, у которых есть кнопка **Download**, а в «Conditions of use» указано, что другим пользоваться можно (Allow). Скачанный `.vrm` положи в `models/marin.vrm` (или `models/ruby.vrm`).
3. Написать автору и попросить разрешение.

Если файла нет, вместо модели будет простая заглушка-девочка (тоже моргает и шевелит ртом), всё остальное работает.

Поддерживаются VRM 0.x и 1.0. Для слабого ноута: модели попроще (меньше 30 МБ), `"maxPixelRatio": 1`, `"antialias": false` в `avatar`.

## Мозг (ИИ) и стоимость

`config.json → llm.provider` (или `COMPANION_LLM=` в .env):

| provider | модель | ключ в .env |
|---|---|---|
| `xai` (по умолч.) | `grok-4.3` | `XAI_API_KEY` |
| `openai-luna` | `gpt-6-luna` — самая дешёвая | `OPENAI_API_KEY` |
| `openai-terra` | `gpt-6.1-terra` | `OPENAI_API_KEY` |
| `ollama` | локальная модель (нужно мощное железо) | — |

**Сколько стоит:** голос и распознавание бесплатные (работают на ноуте). Платишь только за текст ИИ. Ответ Grok 4.3 обходится примерно в полцента, так что **$10 хватит примерно на 2 000 сообщений, это около 70 в день весь месяц**. На `openai-luna` выходит примерно в 10 раз дешевле, но она глупее. Чтобы было ещё дешевле, уменьши `llm.historyTurns` (по умолчанию 10, это сколько последних реплик она помнит) или `llm.maxTokens`. Потраченные токены показывает `bin/companion-ctl status`.

## Голос

- **Озвучка:** Piper, голос `ru_RU-irina-medium`. Другие русские голоса: `VOICE=ruslan ./scripts/download-models.sh` (а также `denis`, `dmitri`, но они мужские), потом поменяй `model` в `tts.providers.piper`. Скорость задаётся в `lengthScale`: меньше значит быстрее.
- **Облачный голос:** провайдер `openai` в `tts.providers` (около полутора центов за минуту речи).
- **Свой аниме-голос (RVC):** провайдер типа `command` запускает любой скрипт, который пишет WAV в `{out}`. Например, Piper → RVC. Пример есть в `tts.providers.rvc-example`.
- **Распознавание:** whisper.cpp, модель `base`. Если распознаёт плохо, поставь `WHISPER_MODEL=small ./scripts/download-models.sh` и поменяй путь в `stt.providers.whispercpp.model` на `ggml-small.bin`: точнее, но примерно в 3 раза медленнее. Есть и альтернатива: `WITH_FASTER_WHISPER=1 ./scripts/install-arch.sh` и `"stt": {"provider": "faster-whisper"}`.

## Безопасность команд

- Программы она открывает только из списка `tools.apps`: ключ, русские названия, команда. Свои программы добавляй туда.
- `run_command` без вопросов выполняет только простые команды из `tools.allowedCommands` (`df`, `free`, `uptime`…), без `; | > $` и прочего.
- Всё остальное, а также всё с `rm`, `sudo`, `kill`, `pacman`, `mv`, `chmod`, `systemctl` и т.д. (даже если оно в списке), она сначала спрашивает: «Выполнить …? Скажи да или нет». Подтвердить можно голосом («да»), кнопкой в окне или командой `companion-ctl yes`. Любой другой ответ отменяет действие.

## Если что-то не так

- **Окно с чёрным фоном или не появляется** → `COMPANION_NO_GPU=1 bin/run.sh`.
- **Ошибка `chrome-sandbox` / SUID sandbox** (например, на ядре linux-hardened) → `bin/run.sh --no-sandbox`.
- **Правила окна не применяются** → `hyprctl clients` и посмотри title/class окна. Title должен быть `Anime Companion`.
- **Клики не проходят сквозь окно** → в Hyprland нет такого правила окна, это делает само приложение (Electron). Если на твоей системе не работает, спрячь её (Super+Alt+Z) или уменьши `size` в правиле.
- **Не слышит** → `pw-record /tmp/t.wav` (Ctrl+C), потом `pw-play /tmp/t.wav`. Проверь, какой микрофон выбран: `wpctl status`.
- **Лог** → `~/.local/state/anime-companion.log`, подробный: `COMPANION_DEBUG=1` в .env.

## Для разработки

`npm test` запускает тесты слоя ИИ и инструментов с поддельным API. `COMPANION_DEVTOOLS=1 bin/run.sh` открывает DevTools.
Если правишь `<script type="importmap">` в `src/renderer/index.html`, пересчитай sha256 в Content-Security-Policy.
