#!/usr/bin/env bash
#
# Собирает общий (multi-tenant) инстанс и перезапускает его.
#
# Сборка идёт В СВОЁМ worktree и БЕЗ общего замка. Замок берётся только на
# подмену готовых файлов и перезапуск — это секунды вместо десяти-пятнадцати
# минут. Раньше замок держался всю сборку целиком, и два чата, ведущих проект,
# блокировали друг друга наглухо: один стоял в очереди, не имея возможности
# ничего сообщить, а со стороны это выглядело как зависание.
#
# Использование: bash deploy/build-shared.sh <коммит> [--no-restart]
#   Запускать из своего worktree. Скрипт сам проверит, что он на этом коммите.

set -uo pipefail

COMMIT="${1:?укажите коммит}"
NO_RESTART=""
ALLOW_ROLLBACK=""
for arg in "${@:2}"; do
    case "$arg" in
        --no-restart) NO_RESTART="--no-restart" ;;
        --allow-rollback) ALLOW_ROLLBACK=1 ;;
    esac
done
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHARED="/home/claude/claudecodeui-shared"
SOURCE_MODULES="/home/claude/claudecodeui/node_modules"
DB="/home/claude/.cloudcli-shared/auth.db"
BACKUP_DIR="/home/claude/.cloudcli-shared/backups"
ATTEMPTS=12

say() { echo "[$(date +%H:%M:%S)] $*"; }

# ── Шаг 1. Сборка у себя, без общего замка ───────────────────────────────────

cd "$SELF" || exit 1
HEAD_NOW="$(git rev-parse HEAD)"
if [ "${HEAD_NOW:0:${#COMMIT}}" != "$COMMIT" ]; then
    say "ОШИБКА: $SELF стоит на $HEAD_NOW, а собрать просят $COMMIT"
    exit 1
fi
say "Сборка в своём каталоге: $(git log --oneline -1)"

# Выкатка не затирает чужую работу. Сайт общий, выкатывают несколько чатов, и
# каждый — свою ветку. 15.09.26 правку «сообщения не теряются» (12:07) за
# полчаса молча сняли семь чужих выкаток веток без неё; страница осталась
# новой, сервер — старым, и сообщения посыпались ошибками. Выкатывать можно
# только коммит, в котором уже есть то, что сейчас на сайте. Намеренный откат —
# флаг --allow-rollback. Такая же проверка стоит хуком для всех чатов
# (~/.claude/hooks/ccui-deploy-guard.py): у соседей может быть старая копия
# этого скрипта.
LIVE="$(git -C "$SHARED" rev-parse HEAD 2>/dev/null)"
[ -n "$LIVE" ] || say "ВНИМАНИЕ: не удалось узнать живой коммит сайта — проверка на затирание чужой работы пропущена"
if [ -z "$NO_RESTART" ] && [ -n "$LIVE" ] && ! git merge-base --is-ancestor "$LIVE" "$HEAD_NOW"; then
    if [ -z "$ALLOW_ROLLBACK" ]; then
        say "ОШИБКА: на сайте сейчас $(git -C "$SHARED" log -1 --format='%h %s'),"
        say "а в $COMMIT этого нет — выкатка сняла бы чужую работу."
        say "Сначала влейте живой коммит в свою ветку (git merge ${LIVE:0:8}), соберите и выкатывайте."
        say "Намеренный откат: добавьте --allow-rollback."
        exit 1
    fi
    say "ВНИМАНИЕ: намеренный откат — на сайте было ${LIVE:0:8}"
fi

# Жёсткие ссылки вместо npm install: семь секунд, места не занимают и, в отличие
# от установки в worktree, не теряют молча devDependencies.
cp -al "$SOURCE_MODULES/." node_modules/ 2>/dev/null
if [ ! -x node_modules/.bin/vite ]; then
    say "ОШИБКА: vite не найден после cp -al"
    exit 1
fi

# Node подбирает размер кучи по СВОБОДНОЙ памяти на момент запуска. На
# загруженном сервере он брал 259 МБ, компилятор уходил в бесконечную сборку
# мусора и падал с «heap out of memory». Это и была та самая «сборка регулярно
# падает по памяти» — не нехватка ОЗУ, а слишком скромный лимит по умолчанию.
export NODE_OPTIONS="--max-old-space-size=1536"
export OPEN_REGISTRATION=true

built=0
for attempt in $(seq 1 "$ATTEMPTS"); do
    say "Сборка, попытка $attempt из $ATTEMPTS"
    if nice -n 19 ionice -c 3 npm run build; then
        built=1
        say "Сборка удалась"
        break
    fi
    say "Попытка $attempt не удалась, пауза 45 с"
    sleep 45
done
[ "$built" -eq 1 ] || { say "ОШИБКА: не собралось за $ATTEMPTS попыток"; exit 1; }

# Проверяем СОДЕРЖИМЫМ, а не временем файла: dist-server умеет сохранять старые
# mtime, поэтому «свежесть» по дате врёт.
missing=""
grep -rq "account_scan_state" "$SELF/dist-server" 2>/dev/null || missing="$missing разделение-аккаунтов"
grep -rq "loginToken" "$SELF/dist/assets" 2>/dev/null || missing="$missing иконка-на-экране-Домой"
[ -z "$missing" ] || { say "ОШИБКА: в собранных файлах нет правок:$missing"; exit 1; }
say "Проверка содержимого пройдена"

if [ "$NO_RESTART" = "--no-restart" ]; then
    say "Подмена и перезапуск пропущены по флагу"
    exit 0
fi

# ── Шаг 2. Подмена и перезапуск — под общим замком, считанные секунды ─────────

mkdir -p "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/auth.db.bak-$(date +%Y%m%d-%H%M%S)"

say "Жду общий замок…"
LOCK_WAIT_START=$SECONDS
exec 9>/tmp/ccui-deploy.lock
if ! flock -w 3600 9; then
    say "ОШИБКА: замок занят дольше часа"
    exit 1
fi
say "Замок взят (ждал $((SECONDS - LOCK_WAIT_START)) с)"
LOCK_HELD_START=$SECONDS

# Перезапуск в забитую группу памяти = долгий простой. 22.09.26 агенты чатов
# с их ffmpeg и сборками заняли 2,73 ГБ группы службы при потолке 2,5 ГБ;
# новый сервер больше 15 минут не открывал порт — «Секунду, обновляюсь».
# С 22.09 новые агенты живут в ccui-agents.slice (agent-rooms.js), но
# пережившие перезапуск старые остаются в группе, пока не закончат.
CG=/sys/fs/cgroup/system.slice/claudecodeui-shared.service
# Продлить аренду ожидания (SIGUSR2, 2 мин) на шагах ПОСЛЕ wait_restart_safe_window:
# ожидание памяти может длиться до 5 мин — без продления вход открылся бы
# и Devin-ход стартовал бы прямо под перезапуск.
renew_drain() {
    local pid
    pid="$(systemctl show claudecodeui-shared -p MainPID --value 2>/dev/null)"
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -USR2 "$pid" 2>/dev/null
    return 0
}
wait_room_free() {
    local high cur waited=0
    high="$(cat "$CG/memory.high" 2>/dev/null)"
    [[ "$high" =~ ^[0-9]+$ ]] || return 0
    while :; do
        cur="$(cat "$CG/memory.current" 2>/dev/null || echo 0)"
        [ "$cur" -lt $((high * 85 / 100)) ] && return 0
        if [ "$waited" -ge 300 ]; then
            say "ВНИМАНИЕ: группа сайта всё ещё забита ($((cur/1048576)) из $((high/1048576)) МБ) — перезапускаю, подъём может быть долгим"
            return 0
        fi
        [ "$waited" -eq 0 ] && {
            say "Группа сайта забита: $((cur/1048576)) из $((high/1048576)) МБ — жду до 5 мин, иначе новый сервер застрянет. Кто занял:"
            for p in $(cat "$CG/cgroup.procs"); do ps -o rss=,etime=,args= -p "$p" 2>/dev/null; done | sort -n -r | head -5 | cut -c1-120
        }
        renew_drain
        sleep 15; waited=$((waited + 15))
    done
}

wait_site_up() {
    local t0=$SECONDS
    while [ $((SECONDS - t0)) -lt 300 ]; do
        if curl -s -o /dev/null --max-time 5 -w '%{http_code}' http://127.0.0.1:3003/ | grep -q 200; then
            say "Сайт ответил через $((SECONDS - t0)) с после перезапуска"
            [ $((SECONDS - t0)) -gt 60 ] && /home/claude/scripts/notify.sh "Claude UI поднимался $((SECONDS - t0)) с после выкатки — дольше минуты, разобраться" error >/dev/null 2>&1
            return 0
        fi
        sleep 2
    done
    say "ОШИБКА: сайт не ответил за 5 мин после перезапуска"
    /home/claude/scripts/notify.sh "Claude UI не поднялся за 5 мин после выкатки" error >/dev/null 2>&1
    return 0
}

# Codex, в отличие от Claude, не умеет переподключить уже идущий turn к
# новому Node-процессу: рестарт записывает turn_aborted. Сначала SIGUSR2
# закрывает вход новым запускам (их сообщения остаются в серверной очереди),
# затем ждём, пока все не-Claude ходы закончатся. Без таймаута намеренно:
# обновление сайта может подождать, работа человека — нет.
# SIGUSR2 — аренда на 2 минуты, поэтому шлём его на КАЖДОМ шаге: 04.10.26
# скрипт оборвался вместе со своим чатом, а разовый сигнал оставил вход
# закрытым на 33 минуты. Нет скрипта — нет продления — сайт открылся сам.
wait_restart_safe_window() {
    local main_pid health blocking draining waited=0
    while :; do
        main_pid="$(systemctl show claudecodeui-shared -p MainPID --value 2>/dev/null)"
        if [[ ! "$main_pid" =~ ^[1-9][0-9]*$ ]]; then
            say "ОШИБКА: не удалось узнать PID живого Claude UI — безопасный перезапуск невозможен"
            return 1
        fi
        if ! kill -USR2 "$main_pid" 2>/dev/null; then
            say "ОШИБКА: не удалось включить ожидание у PID $main_pid"
            return 1
        fi

        health="$(curl -sS --max-time 5 http://127.0.0.1:3003/health 2>/dev/null || true)"
        blocking="$(sed -n 's/.*"restartBlockingRuns":\([0-9][0-9]*\).*/\1/p' <<<"$health")"
        draining="$(sed -n 's/.*"draining":\(true\|false\).*/\1/p' <<<"$health")"
        if [ "$draining" = true ] && [ "$blocking" = 0 ]; then
            [ "$waited" -gt 0 ] && say "Активные ходы закончились — можно безопасно перезапускать"
            return 0
        fi
        if [ -z "$blocking" ] || [ -z "$draining" ]; then
            say "ОШИБКА: живая версия ещё не умеет безопасно ждать Codex; автоматический перезапуск остановлен"
            return 1
        fi
        if [ "$waited" -eq 0 ] || [ $((waited % 30)) -eq 0 ]; then
            say "Перед перезапуском жду активные не-Claude ходы: $blocking (новые сообщения остаются в очереди)"
        fi
        sleep 5
        waited=$((waited + 5))
    done
}

swap() {
    cd "$SHARED" || return 1
    # Живой коммит обязан входить в собираемый. 16.09.26 два чата выкатили
    # сборки с разницей в 10 секунд, второй — от старого коммита, и три
    # исправления первого молча пропали с сайта. Сначала влей живой HEAD.
    local live
    live="$(git rev-parse HEAD)"
    if ! git merge-base --is-ancestor "$live" "$COMMIT"; then
        say "ОШИБКА: на сайте $live, его нет в $COMMIT — влей живой коммит и собери заново"
        SWAP_REFUSED=1
        return 1
    fi
    wait_restart_safe_window || return 1
    git checkout -q "$COMMIT" || return 1

    # Предыдущая сборка не удаляется, а отодвигается в *.prev — это мгновенный
    # откат, если новая окажется нерабочей.
    for d in dist dist-server; do
        rm -rf "$d.prev"
        [ -d "$d" ] && mv "$d" "$d.prev"
        cp -a "$SELF/$d" "$d" || return 1
    done

    renew_drain
    cp -a "$DB" "$BACKUP"
    wait_room_free
    renew_drain
    sudo -n systemctl restart claudecodeui-shared
    wait_site_up
}

if swap; then
    say "Подменено и перезапущено. Замок держался $((SECONDS - LOCK_HELD_START)) с"
    say "Копия базы: $BACKUP"
    say "Откат при необходимости: mv dist.prev dist && mv dist-server.prev dist-server && sudo -n systemctl restart claudecodeui-shared"
elif [ "${SWAP_REFUSED:-0}" = 1 ]; then
    # Файлы сайта не трогали — откатывать нечего.
    exit 1
else
    say "ОШИБКА на подмене — возвращаю предыдущую сборку"
    cd "$SHARED" && for d in dist dist-server; do
        [ -d "$d.prev" ] && rm -rf "$d" && mv "$d.prev" "$d"
    done
    sudo -n systemctl restart claudecodeui-shared
    exit 1
fi
