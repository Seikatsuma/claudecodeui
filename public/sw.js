// Service Worker for CloudCLI PWA
// Cache only manifest (needed for PWA install). HTML and JS are never pre-cached
// so a rebuild + refresh always picks up the latest assets.
// Имя меняется вместе с любым изменением этого файла: браузер переустанавливает
// служебный кэш только когда сам файл стал другим побайтово. Установленное на
// экран «Домой» приложение месяц отдавало старую сборку именно поэтому.
const CACHE_NAME = 'claude-ui-v5';
const urlsToCache = [
  '/manifest.json'
];

/**
 * Заранее кладёт в кэш куски новой сборки.
 *
 * Замер холодного запуска по мобильной сети: 9,5 секунды до рабочего экрана,
 * из них почти всё — скачивание. А холодным он у Егора оказывается почти
 * всегда: каждая выкатка меняет имена файлов, и телефон честно тянет их
 * заново при первом же открытии.
 *
 * Поэтому новый служебный файл, устанавливаясь, сам читает свежую страницу,
 * достаёт из неё имена кусков и складывает их в кэш — в фоне, пока человек
 * ещё ничего не открыл. К моменту, когда он зайдёт, всё уже лежит на
 * телефоне, и открытие идёт из памяти.
 *
 * Ошибки здесь намеренно проглатываются: не сумели прогреть — просто
 * скачается при открытии, как раньше. Установку это блокировать не должно.
 */
function precacheBuild() {
  return fetch('/index.html', { cache: 'no-store' })
    .then(response => (response.ok ? response.text() : Promise.reject(new Error('нет страницы'))))
    .then(html => {
      const assets = [];
      const pattern = /(?:src|href)="(\/assets\/[^"]+)"/g;
      let found = pattern.exec(html);
      while (found) {
        assets.push(found[1]);
        found = pattern.exec(html);
      }
      if (assets.length === 0) return undefined;
      return caches.open(CACHE_NAME).then(cache => cache.addAll(assets));
    })
    .catch(() => undefined);
}

// Install event
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .then(() => precacheBuild()),
  );
  self.skipWaiting();
});

const OFFLINE_PAGE_KEY = '/__last-good-page';

/**
 * Поход в сеть с одной повторной попыткой.
 *
 * Перезапуск службы занимает секунды, и одиночный запрос, попавший ровно в
 * это окно, раньше означал мёртвый экран. Одна пауза в полторы секунды
 * закрывает почти все такие случаи.
 */
function fetchWithRetry(request) {
  return fetch(request).catch(() =>
    new Promise(resolve => setTimeout(resolve, 1500)).then(() => fetch(request)),
  );
}

/** Страница-заглушка, которая сама пробует подключиться заново. */
function retryingPage() {
  const html = [
    '<!doctype html><html lang="ru"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
    '<title>Соединяюсь…</title>',
    '<style>',
    'html,body{height:100%;margin:0;background:#0b0b0c;color:#e7e7ea;',
    'font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    'div{height:100%;display:flex;flex-direction:column;align-items:center;',
    'justify-content:center;gap:14px;padding:24px;text-align:center}',
    'b{font-size:17px;font-weight:600}',
    'p{margin:0;color:#a1a1aa;max-width:22rem}',
    'button{margin-top:6px;padding:10px 18px;border:0;border-radius:10px;',
    'background:#3b82f6;color:#fff;font-size:15px}',
    '</style></head><body><div>',
    '<b>Соединяюсь с сервером…</b>',
    '<p>Связь пропала или сервер обновляется. Страница откроется сама, как только он ответит.</p>',
    '<button onclick="location.reload()">Попробовать сейчас</button>',
    '</div>',
    '<script>setInterval(function(){',
    'fetch("/",{method:"HEAD",cache:"no-store"}).then(function(r){',
    'if(r.ok||r.status===302)location.reload();}).catch(function(){});',
    '},3000);<\/script>',
    '</body></html>',
  ].join('');
  return new Response(html, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// Fetch event — network-first for everything except hashed assets
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Never intercept API requests or WebSocket upgrades
  if (url.includes('/api/') || url.includes('/ws')) {
    return;
  }

  // Открытие страницы: сеть, но с запасом и без тупика.
  //
  // Разбор аварии 09.09. Раньше здесь был ровно один поход в сеть, и если он
  // не удался — отдавалась намертво статичная страница «Offline» без единой
  // кнопки. Хуже всего, что попасть в неё было проще простого: при выкатке
  // служба перезапускается и секунд пять недоступна. То есть собственные
  // обновления выбивали Егора в мёртвый экран, и он оставался там, пока не
  // догадается перезагрузить вручную.
  //
  // Теперь три ступени: сеть → последняя удачная страница из кэша → страница,
  // которая сама повторяет попытку. Ни одна из них не оставляет человека
  // перед неподвижной надписью.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetchWithRetry(event.request)
        .then(response => {
          // Запоминаем последнюю удачную страницу: пригодится, пока сервер
          // перезапускается. Собранные куски (JS и стили) лежат в том же
          // кэше и берутся из него, поэтому пара «страница + куски» остаётся
          // согласованной.
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(OFFLINE_PAGE_KEY, clone));
          return response;
        })
        .catch(() => caches.match(OFFLINE_PAGE_KEY).then(cached => cached || retryingPage()))
    );
    return;
  }

  // Hashed assets (JS/CSS in /assets/) — cache-first since filenames change per build
  if (url.includes('/assets/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        });
      })
    );
    return;
  }

  // Everything else — network-first
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// Activate event — purge old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames =>
      Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      )
    )
  );
  event.waitUntil(self.clients.claim().then(() =>
    self.clients.matchAll({ type: 'window' }).then(clients => {
      // Страница, оставшаяся от прошлой сборки, сама себя перезагрузит:
      // на телефоне закрыть и открыть приложение бывает недостаточно.
      clients.forEach(client => client.postMessage({ type: 'sw:updated' }));
    })
  ));
});

// Push notification event
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'CloudCLI', body: event.data.text() };
  }

  const options = {
    body: payload.body || '',
    icon: '/logo-256.png',
    badge: '/logo-128.png',
    data: payload.data || {},
    tag: payload.data?.tag || `${payload.data?.sessionId || 'global'}:${payload.data?.code || 'default'}`,
    renotify: true
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'CloudCLI', options)
  );
});

// Notification click event
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const sessionId = event.notification.data?.sessionId;
  const provider = event.notification.data?.provider || null;
  const urlPath = sessionId ? `/session/${sessionId}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          await client.focus();
          client.postMessage({
            type: 'notification:navigate',
            sessionId: sessionId || null,
            provider,
            urlPath
          });
          return;
        }
      }
      return self.clients.openWindow(urlPath);
    })
  );
});
