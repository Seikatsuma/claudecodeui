#!/usr/bin/env bash
#
# Ставит общий (multi-tenant) инстанс CloudCLI на обычный порт 443 по адресу
# https://cc.sobsila.ru/ — вдобавок к существующему https://sobsila.ru:8444/,
# который продолжает работать как запасной вход.
#
# Зачем: 8444 — нестандартный порт. Многие корпоративные сети и часть VPN
# выпускают наружу только 80 и 443, а остальное молча отбрасывают, поэтому
# приложение на таких сетях просто «не открывается». Отдельный поддомен даёт
# инстансу обычный порт, не отбирая корень домена у сайта, который там уже живёт.
#
# Запускать от root (нужен доступ к /etc/nginx и /etc/letsencrypt):
#     sudo bash /home/claude/claudecodeui-b/deploy/setup-cc-subdomain.sh
#
# Скрипт идемпотентен: повторный запуск ничего не ломает и не перевыпускает
# уже существующий сертификат. При любой ошибке конфигурация nginx
# возвращается к исходной, и nginx остаётся работать на прежних настройках
# (проверка `nginx -t` идёт всегда ДО reload).

set -euo pipefail

DOMAIN="cc.sobsila.ru"
CONF="/etc/nginx/conf.d/claudecodeui-shared-server.conf"
# Копия кладётся ВНЕ /etc/nginx/conf.d: каталог подключается маской *.conf, и
# держать там файлы, отличающиеся от рабочих одним суффиксом, — приглашение к
# случайной беде при следующем переименовании.
BACKUP_DIR="/var/backups/claudecodeui-nginx"
BACKUP="${BACKUP_DIR}/$(basename "$CONF").bak-$(date +%Y%m%d-%H%M%S)"
WEBROOT="/var/www/html"
APP_PORT="3003"

if [[ $EUID -ne 0 ]]; then
    echo "ОШИБКА: запускать через sudo — нужен доступ к /etc/nginx и /etc/letsencrypt." >&2
    exit 1
fi

echo "==> Резервная копия текущей конфигурации: $BACKUP"
mkdir -p "$BACKUP_DIR"
cp -a "$CONF" "$BACKUP"

# Откат к исходному состоянию при любой ошибке ниже. nginx при этом продолжает
# работать на старой конфигурации: reload делается только после успешной
# проверки, поэтому «сломанного» состояния между шагами не существует.
rollback() {
    echo "!!! Ошибка. Возвращаю конфигурацию из $BACKUP" >&2
    cp -a "$BACKUP" "$CONF"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
}
trap rollback ERR

# ── Шаг 1: порт 80 ───────────────────────────────────────────────────────────
# Нужен для проверки владения доменом при выпуске сертификата (Let's Encrypt
# обращается по http на /.well-known/acme-challenge/) и для всех последующих
# автопродлений, а также чтобы адрес, набранный без "https://", сам уходил на
# защищённое соединение.
if grep -q "server_name $DOMAIN;" "$CONF"; then
    echo "==> Шаг 1: блоки для $DOMAIN уже есть, пропускаю"
else
    echo "==> Шаг 1: добавляю обработку порта 80 для $DOMAIN"
    cat >> "$CONF" <<'NGINX'

# ─────────────────────────────────────────────────────────────────────────────
# cc.sobsila.ru — тот же общий инстанс на СТАНДАРТНОМ порту.
# :8444 выше намеренно остаётся живым как запасной вход: если одна сеть режет
# один маршрут, второй продолжает работать.
#
# Блок с "_" объявлен default_server НАМЕРЕННО. conf.d/*.conf включается в
# конфигурацию раньше sites-enabled/*, поэтому первый же `listen 80` здесь
# иначе молча перехватил бы роль сервера по умолчанию у блока основного домена
# и изменил бы ответ на неизвестные имена и на голый IP. Так ответ остаётся
# ровно прежним — 404.
# ─────────────────────────────────────────────────────────────────────────────
server {
    listen 80 default_server;
    server_name _;

    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 404; }
}

server {
    listen 80;
    server_name cc.sobsila.ru;

    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}
NGINX

    nginx -t
    systemctl reload nginx
    echo "    порт 80 настроен, nginx перечитан мягко (живые соединения не рвутся)"
fi

# ── Шаг 2: сертификат ────────────────────────────────────────────────────────
# --deploy-hook нужен, чтобы автопродление через полгода не осталось лежать на
# диске незамеченным: без перечитывания nginx продолжил бы отдавать старый
# сертификат до ближайшего ручного reload.
if [[ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
    echo "==> Шаг 2: сертификат для $DOMAIN уже выпущен, пропускаю"
else
    echo "==> Шаг 2: выпускаю сертификат для $DOMAIN"
    mkdir -p "$WEBROOT"
    certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
        --deploy-hook "systemctl reload nginx"
fi

# ── Шаг 3: порт 443 ──────────────────────────────────────────────────────────
# Настройки скопированы с блока :8444 один в один (сжатие, вебсокеты, длинные
# таймауты для стриминга ответов): расхождение между двумя входами в одно и то
# же приложение потом ловится часами.
if grep -q "listen 443 ssl;" "$CONF"; then
    echo "==> Шаг 3: блок 443 для $DOMAIN уже есть, пропускаю"
else
    echo "==> Шаг 3: включаю $DOMAIN на порту 443"
    cat >> "$CONF" <<NGINX

server {
    # Синтаксис под nginx 1.24 (версия на этом сервере): отдельная директива
    # "http2 on;" появилась только в 1.25.1 и здесь роняет проверку конфигурации.
    listen 443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    gzip on;
    gzip_proxied any;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_vary on;
    gzip_types application/javascript text/javascript application/json text/css image/svg+xml application/manifest+json;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX

    nginx -t
    systemctl reload nginx
    echo "    порт 443 настроен, nginx перечитан мягко"
fi

trap - ERR

# ── Проверка ─────────────────────────────────────────────────────────────────
echo
echo "==> Проверка"

# С повторами: `systemctl reload` возвращает управление раньше, чем новые
# рабочие процессы начинают принимать соединения, поэтому проверка сразу
# после него один раз уже давала пустой ответ на полностью исправной
# конфигурации — ложная тревога дороже трёх секунд ожидания.
probe() {
    local scheme=$1 port=$2 want=$3 code=""
    for _ in 1 2 3 4 5; do
        code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
                    --resolve "$DOMAIN:$port:127.0.0.1" "$scheme://$DOMAIN/" || true)
        [[ "$code" == "$want" ]] && break
        sleep 1
    done
    printf '    %-28s %s   (ожидается %s)\n' "$scheme://$DOMAIN/" "${code:-нет ответа}" "$want"
}

probe https 443 200
probe http  80  301
echo
echo "Готово. Резервная копия прежней конфигурации: $BACKUP"
