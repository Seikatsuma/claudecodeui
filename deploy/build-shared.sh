#!/usr/bin/env bash
#
# Собирает общий (multi-tenant) инстанс из заданного коммита и перезапускает его.
#
# Весь цикл идёт под общим замком /tmp/ccui-deploy.lock: рабочий каталог
# claudecodeui-shared и сервис у обоих чатов, ведущих этот проект, одни и те же.
# Две одновременные сборки означают испорченный dist, деплой чужого коммита и
# взаимное убийство по памяти на 3.8 ГБ. Замок держится до конца скрипта,
# включая перезапуск.
#
# Использование: bash deploy/build-shared.sh <коммит> [--no-restart]

set -uo pipefail

COMMIT="${1:?укажите коммит}"
NO_RESTART="${2:-}"
SHARED="/home/claude/claudecodeui-shared"
SOURCE_MODULES="/home/claude/claudecodeui/node_modules"
DB="/home/claude/.cloudcli-shared/auth.db"
BACKUP_DIR="/home/claude/.cloudcli-shared/backups"
ATTEMPTS=12

exec 9>/tmp/ccui-deploy.lock
if ! flock -w 3600 9; then
    echo "ОШИБКА: замок сборки занят дольше часа — выхожу, чтобы не мешать соседнему чату"
    exit 1
fi
echo "==> Замок сборки взят"

cd "$SHARED" || exit 1
PREVIOUS_HEAD="$(git rev-parse HEAD)"
echo "==> Было: $(git log --oneline -1)"

git checkout -q "$COMMIT" || { echo "ОШИБКА: не удалось переключиться на $COMMIT"; exit 1; }
echo "==> Стало: $(git log --oneline -1)"

# Жёсткие ссылки вместо npm install: семь секунд, не занимают места и, в отличие
# от установки в worktree, не теряют молча devDependencies. Нужно перед КАЖДОЙ
# сборкой — предыдущий прогон делает prune и уносит vite с остальными dev-зависимостями.
cp -al "$SOURCE_MODULES/." node_modules/ 2>/dev/null
if [ ! -x node_modules/.bin/vite ]; then
    echo "ОШИБКА: vite не найден после cp -al"
    exit 1
fi

# Node подбирает размер кучи по СВОБОДНОЙ памяти на момент запуска. На
# загруженном сервере он выбирал 259 МБ, компилятор уходил в бесконечную сборку
# мусора и падал с «heap out of memory». Это и была та самая «сборка регулярно
# падает по памяти» — не нехватка ОЗУ, а слишком скромный лимит по умолчанию.
export NODE_OPTIONS="--max-old-space-size=1536"
export OPEN_REGISTRATION=true

built=0
for attempt in $(seq 1 "$ATTEMPTS"); do
    echo "==> Сборка, попытка $attempt из $ATTEMPTS"
    if nice -n 19 ionice -c 3 npm run build; then
        built=1
        echo "    сборка удалась"
        break
    fi
    echo "    попытка $attempt не удалась, пауза 45 с"
    sleep 45
done

if [ "$built" -ne 1 ]; then
    echo "ОШИБКА: сборка не удалась за $ATTEMPTS попыток. Возвращаю worktree на $PREVIOUS_HEAD"
    git checkout -q "$PREVIOUS_HEAD"
    exit 1
fi

# Проверяем СОДЕРЖИМЫМ, а не временем файла: dist-server умеет сохранять старые
# mtime, поэтому «свежесть» по дате врёт.
missing=""
grep -rq "account_scan_state" dist-server 2>/dev/null || missing="$missing разделение-аккаунтов"
grep -rq "loginToken" dist/assets 2>/dev/null || missing="$missing иконка-на-экране-Домой"
if [ -n "$missing" ]; then
    echo "ОШИБКА: в собранных файлах нет правок:$missing — деплой остановлен"
    exit 1
fi
echo "==> Проверка содержимого пройдена: обе правки на месте"

if [ "$NO_RESTART" = "--no-restart" ]; then
    echo "==> Перезапуск пропущен по флагу"
    exit 0
fi

# Копия базы перед первым запуском с миграцией. Миграция только добавляет
# колонки и таблицу, но откатывать будет нечем, если что-то пойдёт не так.
mkdir -p "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/auth.db.bak-$(date +%Y%m%d-%H%M%S)"
cp -a "$DB" "$BACKUP" && echo "==> Копия базы: $BACKUP"

npm prune --omit=dev >/dev/null 2>&1
sudo -n systemctl restart claudecodeui-shared || { echo "ОШИБКА: перезапуск не удался"; exit 1; }
echo "==> Сервис перезапущен"
