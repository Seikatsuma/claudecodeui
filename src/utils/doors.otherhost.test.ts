import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Чужой адрес (разработка, стенд): запасного входа нет, всё как раньше.
(globalThis as any).sessionStorage = { getItem: () => null, setItem: () => undefined };
(globalThis as any).window = { location: { host: 'localhost:5173', protocol: 'http:' } };

const doors: any = await import('./doors.js');

describe('doors на чужом адресе', () => {
  it('проверка входа — один запрос без таймера и без смены входа', async () => {
    const urls: string[] = [];
    (globalThis as any).fetch = async (url: string) => {
      urls.push(url);
      throw new Error('network');
    };
    await assert.rejects(doors.doorFetch('/api/auth/status', {}, { gate: true }), /network/);
    assert.deepEqual(urls, ['/api/auth/status']);
    assert.equal(doors.getDoorBase(), '');
    assert.equal(doors.getDoorHost(), 'localhost:5173');
    doors.flipDoor('проверка');
    assert.equal(doors.getDoorState().reserve, false);
  });
});
