import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';

/**
 * Один вход вместо двух. Человек входит в аккаунт Claude UI, а локальный
 * интерфейс на его компьютере (свой пользователь в своей базе) программа
 * заводит и открывает сама: имя и случайный пароль лежат в <userData>/local,
 * пароль зашифрован системным хранилищем ключей.
 */
export class LocalAuth {
  constructor({ userDataDir }) {
    this.dir = path.join(userDataDir, 'local');
    this.credentialsPath = path.join(this.dir, 'login.json');
    this.token = null;
    this.origin = null;
  }

  getDatabasePath() {
    return path.join(this.dir, 'claude-ui.db');
  }

  /** До старта сервера: учётка есть, база без учётки — откладывается, а не стирается. */
  async prepare() {
    await fs.mkdir(this.dir, { recursive: true });
    if (!existsSync(this.credentialsPath) && existsSync(this.getDatabasePath())) {
      await fs.rename(this.getDatabasePath(), `${this.getDatabasePath()}.orphan-${Date.now()}`);
    }
  }

  async #readCredentials() {
    try {
      const stored = JSON.parse(await fs.readFile(this.credentialsPath, 'utf8'));
      const password = stored.encrypted
        ? safeStorage.decryptString(Buffer.from(stored.password, 'base64'))
        : stored.password;
      return { username: stored.username, password };
    } catch {
      return null;
    }
  }

  async #writeCredentials(username, password) {
    const encrypted = safeStorage.isEncryptionAvailable();
    await fs.writeFile(this.credentialsPath, JSON.stringify({
      username,
      encrypted,
      password: encrypted ? safeStorage.encryptString(password).toString('base64') : password,
    }, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  static usernameFor(email) {
    const base = String(email || '').split('@')[0].replace(/[^A-Za-z0-9._-]/g, '');
    return base.length >= 3 ? base.slice(0, 40) : 'owner';
  }

  async #post(baseUrl, pathname, body) {
    const response = await fetch(new URL(pathname, baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.token) {
      throw new Error(data.error?.message || data.error || `локальный вход: ответ ${response.status}`);
    }
    return data.token;
  }

  /** Свежий вход в локальный интерфейс (живёт 7 дней — берём при каждом открытии). */
  async ensureToken(baseUrl, accountEmail) {
    const statusResponse = await fetch(new URL('/api/auth/status', baseUrl));
    const status = await statusResponse.json().catch(() => ({}));
    let credentials = await this.#readCredentials();

    if (status.needsSetup) {
      credentials = {
        username: LocalAuth.usernameFor(accountEmail),
        password: crypto.randomBytes(24).toString('base64url'),
      };
      this.token = await this.#post(baseUrl, '/api/auth/register', credentials);
      await this.#writeCredentials(credentials.username, credentials.password);
    } else {
      if (!credentials) {
        throw new Error('Локальный вход потерян. Перезапустите программу — она заведёт его заново.');
      }
      this.token = await this.#post(baseUrl, '/api/auth/login', credentials);
    }
    this.origin = new URL(baseUrl).origin;
    // Мастер первого запуска (Git, подключение агентов) — для сервера, который
    // настраивают руками. В программе человек уже вошёл в аккаунт, а вход в
    // Claude есть в настройках интерфейса; мастер к тому же правит общие
    // настройки Git на компьютере. Отмечаем пройденным, как на сайте.
    await fetch(new URL('/api/user/complete-onboarding', baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
    }).catch(() => {});
    return this.token;
  }

  /** Отдаётся только странице самого локального интерфейса. */
  getTokenForOrigin(origin) {
    return this.token && origin && origin === this.origin ? this.token : null;
  }
}
