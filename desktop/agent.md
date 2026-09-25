# Claude UI для компьютера (Mac, Windows) — ветка desktop-app, с 25.09.26

Егор 25.09: тот же интерфейс, что cc.sobsila.ru, но программой на компьютере; Claude работает с
файлами этого компьютера, как Claude Desktop; внутри — наши мозги (без личной памяти и серверных
правил); вход аккаунтом со второго сервера; любой может зарегистрироваться; узкое окно — панель уезжает.

## Как устроено
- Основа — настольная обёртка исходного проекта (CloudCLI, `electron/`), переделанная:
  - `electron/cloud.js` — аккаунт: вход/регистрация почтой прямо в программе → сервер аккаунтов
    **cc2.sobsila.ru/desktop** (второй сервер, `~/desktop-accounts`, там `agent.md`). Ключ устройства
    шифруется системным хранилищем. Серверы владельца приходят оттуда же и открываются вкладками.
  - `electron/localServer.js` — свой сервер интерфейса всегда (не цепляться к чужому на компьютере),
    Claude — вложенный в пакет `@anthropic-ai/claude-agent-sdk-<система>-<процессор>` (CLAUDE_CLI_PATH).
  - `electron/localAuth.js` — второй вход (в локальный интерфейс) программа делает сама: пользователь
    в своей базе `<userData>/local/claude-ui.db`, вход подкладывает `preload.cjs` до загрузки страницы;
    мастер первого запуска (Git, агенты) отмечается пройденным.
  - `electron/brains.js` — мозги: `<userData>/brains/current` = вложенная `desktop/brains` или новее
    с сервера аккаунтов (версия в `manifest.json`, сравнение строкой ГГГГ.ММ.ДД-N).
  - `electron/main.js` `getServerEnv()` — режимы общего сервера (OPEN_REGISTRATION, .claude-webuser-N,
    второй блок, голос) выключены явно; владелец (тариф owner) — чаты без вопросов, как на сайте.
- Мозги в работе Claude — `server/modules/providers/list/claude/desktop-brains.js` (включается только
  при CLAUDE_UI_BRAINS_DIR): правила → добавка к системным, `protocol.md` → к каждому сообщению,
  `plugin/` → 21 помощник и 6 навыков, защита от удаления → перехватчик PreToolUse (Bash|PowerShell;
  после «да» — префикс USER_CONFIRMED=da). Перехватчики внутри процесса: на Windows нет bash/python.
  Папку `~/.claude` человека не трогаем — его правила и вход в Claude остаются его.
- Узкое окно — `src/components/app/AppContent.tsx`: 768–1023 точки → полоска значков, панель выезжает
  поверх чата; уже 768 — телефонная раскладка. Окно сжимается до 420 (`desktopWindow.js`).

## Сборка и проверка
- `.github/workflows/claudeui-desktop.yml` — Mac (M и Intel) и Windows на машинах GitHub, пуш в
  `desktop-app` или вручную. `scripts/release/build-claudeui-desktop.mjs` кладёт сервер со всеми
  пакетами внутрь (нативные пересобраны под Electron), `smoke-claudeui-desktop.mjs` запускает
  собранную программу там же, входит пробным аккаунтом (секреты CLAUDEUI_SMOKE_*; аккаунт
  smoke-ci@claudeui.test) и снимает экран → артефакты smoke-*.
- Здесь (Linux, без экрана): Xvfb и GTK распакованы без sudo в `/tmp` (см. историю 25.09), Electron
  через Playwright; в пробе окружение чистить — чат наследует настройки сайта (OPEN_REGISTRATION и т.п.).
- Версия программы — `desktop/version.json`.

## Грабли
- Mac подписан «для себя» (ad-hoc): при первом открытии — правой кнопкой → «Открыть» (или Настройки →
  Конфиденциальность → «Всё равно открыть»). Windows без подписи: SmartScreen → «Подробнее» → «Выполнить
  в любом случае». Настоящие подписи — платные (Apple Developer ~$99/год, сертификат Windows).
- Обёртка CloudCLI сжимала страницу дважды (setAutoResize + resize) — оставлен только resize.
- Список чатов — только разговоры, начатые человеком (журнал `~/.claude/history.jsonl`); чаты ботов скрыты.
- Claude на Windows без Git for Windows работает через PowerShell (документация Claude Code).
