#!/usr/bin/env bash
#
# Обновление Claude UI на своём сервере.
#
# Берёт свежую версию из ветки main на GitHub, собирает её РЯДОМ с работающей
# (releases/<коммит>), проверяет — установка зависимостей, сборка с проверкой
# типов, тесты сервера, пробный запуск на запасном порту — и только потом
# переключает. Не прошла проверку — работающая версия не тронута. Не поднялась
# после переключения — откат на прежнюю. Итог каждой попытки пишется в
# update-status.txt, подробности — в логах внутри каталога версии.
#
#   bash update.sh            обычный запуск (таймер claudecodeui-update ночью)
#   bash update.sh --force    обновить сейчас, даже если в интерфейсе идёт работа
#   bash update.sh --first    первая установка: собрать и переключить, службу не трогать
#   bash update.sh --status   что сейчас работает и чем кончилось последнее обновление
#
# Работа в интерфейсе при перезапуске не теряется: служба ставится с
# KillMode=process, запущенные чаты доживают и доделывают ответ. Но до 6 утра
# скрипт всё равно ждёт, пока в службе никто не работает, — после 6 обновляет.

set -uo pipefail

APP="${CCUI_APP_DIR:-$HOME/claudecodeui-app}"
REPO="$APP/repo"
BRANCH="${CCUI_BRANCH:-main}"
SERVICE="${CCUI_SERVICE:-claudecodeui}"
ENV_FILE="$APP/app.env"
STATUS_FILE="$APP/update-status.txt"
MODE="${1:-}"

say() { echo "[$(date '+%F %T')] $*"; }
status() { printf '%s\n%s\n' "$(date '+%F %T')" "$*" > "$STATUS_FILE"; say "$*"; }
envval() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' ; }

# Уборка старых версий: остаются перечисленные в аргументах пути плюс ещё
# $1 самых свежих. Пути приводятся через readlink -f — симлинк или слэш
# на конце в CCUI_APP_DIR не должны выпускать работающую версию под нож.
cleanup_releases() {
    local keep_extra="${1:-1}"; shift
    local protected="" p
    for p in "$@"; do
        protected="$protected $(readlink -f "$p" 2>/dev/null || printf '%s' "$p") "
    done
    local kept=0 dir
    for dir in $(ls -1dt "$APP"/releases/*/ 2>/dev/null); do
        dir="$(readlink -f "${dir%/}")"
        case "$protected" in *" $dir "*) continue ;; esac
        kept=$((kept + 1))
        [ "$kept" -le "$keep_extra" ] && continue
        git -C "$REPO" worktree remove --force "$dir" 2>/dev/null || rm -rf "$dir"
    done
    git -C "$REPO" worktree prune 2>/dev/null
}

# Ошибка после создания каталога версии: журналы сборки (.npm-ci.log и др.)
# остаются для разбора, а node_modules (~1.9 ГБ) удаляется — это почти весь
# вес версии, и без него каталог безопасно дождётся разбора или уборки.
fail() {
    [ -n "${REL:-}" ] && rm -rf "$REL/node_modules" 2>/dev/null
    status "ОШИБКА: $*"
    exit 1
}

if [ "$MODE" = "--status" ]; then
    echo "Сейчас работает версия: $(basename "$(readlink -f "$APP/current" 2>/dev/null || echo нет)")"
    cat "$STATUS_FILE" 2>/dev/null || echo "Обновлений ещё не было"
    exit 0
fi

mkdir -p "$APP/releases" "$APP/backups"
exec 9>"$APP/.update.lock"
flock -n 9 || { say "Обновление уже идёт в другом процессе"; exit 0; }

# Таймер запускает скрипт без профиля пользователя — node из nvm не в PATH.
NODE_DIR="$(envval CCUI_NODE_DIR)"
[ -n "$NODE_DIR" ] && export PATH="$NODE_DIR:$PATH"
command -v node >/dev/null 2>&1 || { status "ОШИБКА: не найден node (CCUI_NODE_DIR в app.env)"; exit 1; }
PORT="$(envval SERVER_PORT)"; PORT="${PORT:-3003}"

git -C "$REPO" fetch -q origin "$BRANCH" \
    || { status "ОШИБКА: нет связи с GitHub — работает прежняя версия"; exit 1; }
NEW="$(git -C "$REPO" rev-parse "origin/$BRANCH")"
SHORT="${NEW:0:12}"
SUBJECT="$(git -C "$REPO" log -1 --format=%s "$NEW")"
CUR_DIR="$(readlink -f "$APP/current" 2>/dev/null || true)"
CUR="$(basename "${CUR_DIR:-нет}")"

# Чистка последствий прошлых падений при каждом запуске: остаются работающая
# версия, свежая цель обновления и ещё две папки.
cleanup_releases 2 "$CUR_DIR" "$APP/releases/$SHORT"

if [ "$CUR" = "$SHORT" ] && [ "$MODE" != "--force" ]; then
    status "Актуально: $SHORT — $SUBJECT"
    exit 0
fi

# Процессов в службе больше одного — значит, в интерфейсе работает чат или
# открыт терминал.
busy_count() {
    local cg
    cg="$(systemctl show -p ControlGroup --value "$SERVICE" 2>/dev/null)"
    if [ -n "$cg" ] && [ -f "/sys/fs/cgroup$cg/cgroup.procs" ]; then
        wc -l < "/sys/fs/cgroup$cg/cgroup.procs"
    else
        echo 0
    fi
}
if [ -z "$MODE" ] && [ "$(date +%H)" -lt 6 ] && [ "$(busy_count)" -gt 1 ]; then
    status "Отложено: в интерфейсе идёт работа. Версия $SHORT подождёт следующей попытки"
    exit 0
fi

REL="$APP/releases/$SHORT"

if [ ! -f "$REL/.verified" ]; then
    # На почти полном диске npm ci гарантированно упадёт и оставит
    # недособранную версию, которая ещё сильнее забивает диск. Уже собранная
    # (.verified) версия доходит до переключения без этой проверки.
    free_kb="$(df -Pk "$APP" 2>/dev/null | awk 'NR==2 {print $4}')"
    free_mb=$(( ${free_kb:-0} / 1024 ))
    min_free_mb="${CCUI_MIN_FREE_MB:-5120}"
    [[ "$min_free_mb" =~ ^[0-9]+$ ]] || min_free_mb=5120
    if [ "$free_mb" -lt "$min_free_mb" ]; then
        status "ПРОПУСК: на диске свободно $((free_mb / 1024)) ГБ (нужно $((min_free_mb / 1024))) — освободите место"
        exit 0
    fi

    git -C "$REPO" worktree prune
    if [ -e "$REL" ]; then
        git -C "$REPO" worktree remove --force "$REL" 2>/dev/null || rm -rf "$REL"
    fi
    git -C "$REPO" worktree add -q --detach "$REL" "$NEW" \
        || fail "не удалось подготовить каталог версии $SHORT"
    cd "$REL" || exit 1

    # Node подбирает размер кучи по свободной памяти на момент старта и на
    # загруженном сервере падает при сборке с «heap out of memory».
    export HUSKY=0 NODE_OPTIONS="--max-old-space-size=${CCUI_BUILD_HEAP_MB:-1536}"

    say "Зависимости версии $SHORT"
    # --include=dev: сборке нужны инструменты разработки (vite, tsc, husky), а
    # NODE_ENV=production или omit=dev в настройках npm молча их пропускают.
    nice -n 19 ionice -c 3 npm ci --include=dev --no-audit --no-fund > .npm-ci.log 2>&1 \
        || fail "не установились зависимости версии $SHORT, работает прежняя. Лог: $REL/.npm-ci.log"

    built=0
    for attempt in 1 2 3; do
        say "Сборка версии $SHORT, попытка $attempt"
        if nice -n 19 ionice -c 3 npm run build > .build.log 2>&1; then built=1; break; fi
        sleep 30
    done
    [ "$built" -eq 1 ] \
        || fail "версия $SHORT не собралась, работает прежняя. Лог: $REL/.build.log"

    if [ "${CCUI_RUN_TESTS:-1}" = "1" ]; then
        say "Тесты сервера версии $SHORT (несколько минут)"
        nice -n 19 ionice -c 3 npm test > .test.log 2>&1
        fails="$(grep -E '^# fail [0-9]+' .test.log | tail -1 | awk '{print $3}')"
        [ -n "$fails" ] \
            || fail "тесты версии $SHORT не запустились, работает прежняя. Лог: $REL/.test.log"
        # Часть тестов зависит от окружения сервера и падает одинаково в любой
        # версии, поэтому мерка — работающая версия: новая не должна падать чаще.
        base="$(cat "$CUR_DIR/.test-fails" 2> /dev/null || true)"
        if [ -n "$base" ] && [ "$fails" -gt "$base" ]; then
            fail "у версии $SHORT упало тестов $fails, у работающей $base — не ставлю. Лог: $REL/.test.log"
        fi
        echo "$fails" > .test-fails
    fi

    # Пробный запуск: пустая база и временный домашний каталог, чтобы проверка
    # не касалась настоящих чатов и входа в Claude.
    smoke_home="$(mktemp -d)"
    smoke_port=$((PORT + 100))
    while ss -ltn 2>/dev/null | grep -q ":$smoke_port "; do smoke_port=$((smoke_port + 1)); done
    HOME="$smoke_home" HOST=127.0.0.1 SERVER_PORT="$smoke_port" NODE_ENV=production \
        DATABASE_PATH="$smoke_home/smoke.db" OPEN_REGISTRATION=true \
        node dist-server/server/index.js > .smoke.log 2>&1 &
    smoke_pid=$!
    smoke_ok=0
    for _ in $(seq 1 60); do
        sleep 2
        kill -0 "$smoke_pid" 2>/dev/null || break
        if curl -sf "http://127.0.0.1:$smoke_port/api/auth/status" | grep -q '"needsSetup":true' \
            && curl -sf "http://127.0.0.1:$smoke_port/" | grep -q 'id="root"'; then
            smoke_ok=1
            break
        fi
    done
    kill "$smoke_pid" 2>/dev/null
    wait "$smoke_pid" 2>/dev/null
    rm -rf "$smoke_home"
    [ "$smoke_ok" -eq 1 ] \
        || fail "версия $SHORT не запустилась на пробе, работает прежняя. Лог: $REL/.smoke.log"

    touch .verified
    cd "$APP" || exit 1
fi

# ── Переключение ─────────────────────────────────────────────────────────────

ln -sfn "releases/$SHORT" "$APP/current.new" && mv -Tf "$APP/current.new" "$APP/current"

if [ "$MODE" = "--first" ]; then
    status "Установлена версия $SHORT — $SUBJECT"
    exit 0
fi

DB="$(envval DATABASE_PATH)"
if [ -n "$DB" ] && [ -f "$DB" ]; then
    backup="$APP/backups/auth-$(date +%Y%m%d-%H%M%S).db"
    if command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "$DB" ".backup '$backup'" 2>/dev/null || cp -a "$DB" "$backup"
    else
        cp -a "$DB" "$backup"
    fi
    ls -1t "$APP"/backups/auth-*.db 2>/dev/null | tail -n +8 | xargs -r rm -f
fi

healthy() {
    for _ in $(seq 1 45); do
        sleep 2
        curl -sf "http://127.0.0.1:$PORT/api/auth/status" > /dev/null && return 0
    done
    return 1
}

rollback() {
    if [ -n "$CUR_DIR" ] && [ -d "$CUR_DIR" ]; then
        ln -sfn "$CUR_DIR" "$APP/current.new" && mv -Tf "$APP/current.new" "$APP/current"
        sudo -n systemctl restart "$SERVICE"
        status "ОШИБКА: версия $SHORT не поднялась ($1) — вернул прежнюю $CUR. Лог: journalctl -u $SERVICE"
    else
        status "ОШИБКА: версия $SHORT не поднялась ($1), прежней версии нет. Лог: journalctl -u $SERVICE"
    fi
    exit 1
}

sudo -n systemctl restart "$SERVICE" || rollback "не удалось перезапустить службу"
healthy || rollback "служба не отвечает"
status "Обновлено до $SHORT — $SUBJECT"

# ── Уборка: работающая, прежняя и ещё одна версия остаются ───────────────────

cleanup_releases 1 "$APP/releases/$SHORT" "$CUR_DIR"
exit 0
