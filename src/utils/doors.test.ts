import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

// doors.js читает window и sessionStorage при загрузке модуля — подставляем до импорта.
const storage = new Map<string, string>();
(globalThis as any).sessionStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
};
(globalThis as any).window = { location: { host: 'cc.sobsila.ru', protocol: 'https:' } };

const doors: any = await import('./doors.js');

type Call = { url: string; signal?: AbortSignal };
const calls: Call[] = [];

const installFetch = (impl: (url: string, init: any) => Promise<any>) => {
  (globalThis as any).fetch = (url: string, init: any = {}) => {
    calls.push({ url, signal: init.signal });
    return impl(url, init);
  };
};

const okResponse = () => ({ ok: true, clone: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) });

// Запрос, который висит, пока его не отменят, — как соединение, замороженное провайдером.
const hanging = (_url: string, init: any) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });

describe('doors: проверка входа через два адреса', () => {
  beforeEach(() => {
    calls.length = 0;
    storage.clear();
    // вернуть основной вход, если прошлый тест оставил запасной
    if (doors.getDoorState().reserve) doors.flipDoor('сброс для теста');
  });

  it('основной ответил — запасной не трогаем', async () => {
    installFetch(async () => okResponse());
    await doors.doorFetch('/api/auth/status', {}, { gate: true });
    assert.deepEqual(calls.map((c) => c.url), ['/api/auth/status']);
    assert.equal(doors.getDoorState().reserve, false);
  });

  it('основной завис — через 7 с идём на запасной и запоминаем его', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      installFetch((url, init) => (url.startsWith('/') ? hanging(url, init) : Promise.resolve(okResponse())));
      const pending = doors.doorFetch('/api/auth/status', {}, { gate: true });
      await Promise.resolve();
      mock.timers.tick(doors.GATE_ATTEMPT_TIMEOUT_MS);
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(doors.GATE_RETRY_PAUSE_MS);
      await pending;
      assert.deepEqual(calls.map((c) => c.url), ['/api/auth/status', 'https://sobsila.ru:8444/api/auth/status']);
      assert.equal(doors.getDoorState().reserve, true);
      assert.equal(doors.getDoorBase(), 'https://sobsila.ru:8444');
      assert.equal(doors.getDoorHost(), 'sobsila.ru:8444');
      assert.ok(storage.get('ccui-door'), 'выбор запомнен в памяти вкладки');
    } finally {
      mock.timers.reset();
    }
  });

  it('оба молчат — после четырёх попыток ошибка, а не вечное ожидание', async () => {
    installFetch(async () => {
      throw new Error('network');
    });
    await assert.rejects(doors.doorFetch('/api/auth/status', {}, { gate: true }), /network/);
    assert.equal(calls.length, doors.GATE_MAX_ATTEMPTS);
  });

  it('обычный запрос не режется по времени и не повторяется', async () => {
    installFetch(async () => ({ ok: true }));
    await doors.doorFetch('/api/projects');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal, undefined);
  });

  it('запись (POST) на проверке входа не повторяется', async () => {
    installFetch(async () => {
      throw new Error('network');
    });
    await assert.rejects(doors.doorFetch('/api/auth/login', { method: 'POST' }, { gate: true }), /network/);
    assert.equal(calls.length, 1);
  });

  it('зависшее тело ответа — такой же сбой: идём на другой адрес', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      installFetch((url, init) =>
        Promise.resolve(
          url.startsWith('/')
            ? { ok: true, clone: () => ({ arrayBuffer: () => hanging(url, init) }) }
            : okResponse(),
        ),
      );
      const pending = doors.doorFetch('/api/auth/status', {}, { gate: true });
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(doors.GATE_ATTEMPT_TIMEOUT_MS);
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(doors.GATE_RETRY_PAUSE_MS);
      await pending;
      assert.equal(calls[calls.length - 1].url, 'https://sobsila.ru:8444/api/auth/status');
    } finally {
      mock.timers.reset();
    }
  });

  it('два зависших запроса сразу не возвращают вход на мёртвый адрес', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      installFetch((url, init) => (url.startsWith('/') ? hanging(url, init) : Promise.resolve(okResponse())));
      const flipsBefore = doors.getDoorState().flips;
      const a = doors.doorFetch('/api/auth/status', {}, { gate: true });
      const b = doors.doorFetch('/api/auth/user', {}, { gate: true });
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(doors.GATE_ATTEMPT_TIMEOUT_MS);
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(doors.GATE_RETRY_PAUSE_MS);
      await Promise.all([a, b]);
      assert.equal(doors.getDoorState().reserve, true, 'вход остался на запасном, а не вернулся на основной');
      assert.equal(doors.getDoorState().flips - flipsBefore, 1, 'на два запроса — одна смена входа');
    } finally {
      mock.timers.reset();
    }
  });

  it('после смены входа обычный запрос идёт на запасной адрес', async () => {
    if (!doors.getDoorState().reserve) doors.flipDoor('для теста');
    installFetch(async () => ({ ok: true }));
    await doors.doorFetch('/api/projects');
    assert.equal(calls[0].url, 'https://sobsila.ru:8444/api/projects');
  });

  it('POST не меняет вход', async () => {
    const before = doors.getDoorState().flips;
    installFetch(async () => {
      throw new Error('network');
    });
    await assert.rejects(doors.doorFetch('/api/auth/login', { method: 'POST' }, { gate: true }), /network/);
    assert.equal(doors.getDoorState().flips, before);
  });
});
