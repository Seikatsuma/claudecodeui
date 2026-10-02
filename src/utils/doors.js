// Два входа на один сервер (02.10.26).
//
// Домашний провайдер Егора по несколько минут подряд «замораживает»
// соединения до 45.39.60.20 (в журнале сервера: рукопожатие начато, ответ до
// телефона не доходит), а потом пропускает снова. Один и тот же сервер
// доступен по двум адресам: cc.sobsila.ru (порт 443, HTTP/2) и
// sobsila.ru:8444 (HTTP/1.1) — это два разных соединения, и в чистое окно
// проходят оба. Раньше страница держалась за один адрес и ждала его сколько
// угодно: единственный зависший запрос проверки входа оставлял Егора на
// экране с тремя точками.
//
// Теперь страница сама уходит на второй адрес, когда первый молчит, и
// запоминает, какой сработал (на 15 минут, в этой вкладке).
//
// Запросы на чтение при проверке входа (`gate`) повторяются с короткой
// паузой, по очереди на оба адреса. Остальные запросы лишь идут по
// запомненному адресу: резать их по времени нельзя — тяжёлый запрос законно
// отвечает долго, а повтор удвоил бы работу сервера.
//
// Работает только на двух известных адресах; на любом другом (разработка,
// чужой стенд) всё как раньше.

const RESERVE_BY_HOST = {
  'cc.sobsila.ru': 'https://sobsila.ru:8444',
  'sobsila.ru:8444': 'https://cc.sobsila.ru',
};

const STORAGE_KEY = 'ccui-door';
const STICKY_MS = 15 * 60 * 1000;
export const GATE_ATTEMPT_TIMEOUT_MS = 7000;
export const GATE_MAX_ATTEMPTS = 4;

const reserveOrigin = () => RESERVE_BY_HOST[window.location.host] || null;

let useReserve = false;
let flips = 0;
const listeners = new Set();

const notify = () => listeners.forEach((listener) => listener());

const remember = () => {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ reserve: useReserve, at: Date.now() }));
  } catch {
    // память вкладки недоступна — запомнится только до перезагрузки
  }
};

try {
  const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
  if (saved && saved.reserve && Date.now() - saved.at < STICKY_MS && reserveOrigin()) {
    useReserve = true;
  }
} catch {
  // нет сохранённого выбора — начинаем с основного адреса
}

/** Адрес, по которому сейчас ходят запросы: '' — тот же, что у страницы. */
export const getDoorBase = () => (useReserve && reserveOrigin() ? reserveOrigin() : '');

/** Хост для WebSocket: тот же адрес, что и у запросов. */
export const getDoorHost = () => {
  const base = getDoorBase();
  return base ? new URL(base).host : window.location.host;
};

/** Переключиться на другой адрес. Без второго адреса ничего не делает. */
export const flipDoor = (reason) => {
  if (!reserveOrigin()) return;
  useReserve = !useReserve;
  flips += 1;
  console.warn(`[door] меняю вход на ${useReserve ? 'запасной' : 'основной'}: ${reason}`);
  remember();
  notify();
};

/** Адрес ответил — запомнить его ещё на 15 минут. */
export const markDoorWorked = () => {
  if (useReserve) remember();
};

/** Состояние для экрана ожидания. */
export const getDoorState = () => ({ reserve: useReserve, flips });

export const subscribeDoor = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const isReadOnly = (options) => {
  const method = (options.method || 'GET').toUpperCase();
  return (method === 'GET' || method === 'HEAD') && !options.signal;
};

/**
 * Запрос к серверу через текущий вход. `gate: true` — запрос проверки входа:
 * ждём ответ не дольше GATE_ATTEMPT_TIMEOUT_MS и пробуем другой адрес.
 */
export const doorFetch = async (path, options = {}, { gate = false } = {}) => {
  if (!gate || !reserveOrigin() || !isReadOnly(options)) {
    const response = await fetch(getDoorBase() + path, options);
    markDoorWorked();
    return response;
  }

  let lastError = null;
  for (let attempt = 0; attempt < GATE_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GATE_ATTEMPT_TIMEOUT_MS);
    try {
      const response = await fetch(getDoorBase() + path, { ...options, signal: controller.signal });
      clearTimeout(timer);
      markDoorWorked();
      return response;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      flipDoor(`проверка входа не прошла (${attempt + 1} из ${GATE_MAX_ATTEMPTS})`);
    }
  }
  throw lastError;
};
