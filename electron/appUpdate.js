import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Обновление программы без нового установщика (Егор 28.09.26: «чтобы обновления
 * выкатывались сами, не скачивать новую версию; кнопка — нажал и обновилось»).
 *
 * Обновляется «начинка» — интерфейс и сервер (dist, dist-server, public, shared):
 * это почти все правки. Оболочка окна (electron/) и пакеты (node_modules, вместе с
 * Claude) остаются из установки: самообновление всей программы на Mac без платной
 * подписи Apple система не пропускает. Если новая начинка требует других пакетов
 * (depsHash не совпал) — кнопка ведёт на страницу скачивания установщика.
 *
 * Где лежит: <userData>/app-update/current — рабочая начинка (её node_modules —
 * ссылка на пакеты установки), previous — прежняя. Версия — номер сборки (build)
 * в update-build.json; у установки он лежит в корне программы.
 */

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 20 * 1000;
const MAX_BUNDLE_BYTES = 300 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export function readBuildInfo(dir) {
  try {
    const info = JSON.parse(readFileSync(path.join(dir, 'update-build.json'), 'utf8'));
    const build = Number(info.build);
    return Number.isFinite(build) && build > 0 ? { ...info, build } : null;
  } catch {
    return null;
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function runTar(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar: код ${code} ${stderr.trim()}`))));
  });
}

export class AppUpdater {
  /**
   * @param {object} options
   * @param {string} options.appRoot       корень установленной программы (там node_modules и update-build.json)
   * @param {string} options.userDataDir   папка данных программы
   * @param {string} options.updateUrl     адрес описания свежей сборки (JSON)
   * @param {(line: string) => void} [options.log]
   * @param {() => void} [options.onChange] состояние изменилось — перерисовать верхнюю полосу
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor({ appRoot, userDataDir, updateUrl, log = () => {}, onChange = () => {}, fetchImpl = globalThis.fetch }) {
    this.appRoot = appRoot;
    this.root = path.join(userDataDir, 'app-update');
    this.currentDir = path.join(this.root, 'current');
    this.badBuildsPath = path.join(this.root, 'bad-builds.json');
    this.updateUrl = updateUrl;
    this.log = log;
    this.onChange = onChange;
    this.fetch = fetchImpl;
    this.installed = readBuildInfo(appRoot);
    this.status = 'idle'; // idle | checking | available | installer | downloading | installing | error
    this.latest = null;
    this.message = '';
    this.timer = null;
  }

  /** Сборки, которые не запустились: второй раз их не ставим и не предлагаем. */
  readBadBuilds() {
    try {
      const list = JSON.parse(readFileSync(this.badBuildsPath, 'utf8'));
      return Array.isArray(list) ? list.map(Number) : [];
    } catch {
      return [];
    }
  }

  /**
   * Начинка, с которой запускать сервер: скачанная, если она новее установки, её
   * пакеты совпадают с установленными и она не помечена как не запустившаяся.
   * Иначе null — сервер берётся из самой программы.
   */
  getActiveRoot() {
    if (!this.installed) return null;
    const active = readBuildInfo(this.currentDir);
    if (!active || active.build <= this.installed.build) return null;
    if (active.depsHash !== this.installed.depsHash) return null;
    if (this.readBadBuilds().includes(active.build)) return null;
    if (!existsSync(path.join(this.currentDir, 'dist-server', 'server', 'index.js'))) return null;
    return this.currentDir;
  }

  getRunningBuild() {
    if (!this.installed) return null;
    return this.getActiveRoot() ? readBuildInfo(this.currentDir).build : this.installed.build;
  }

  getState() {
    return {
      enabled: Boolean(this.installed && this.updateUrl),
      status: this.status,
      build: this.getRunningBuild(),
      latestBuild: this.latest?.build ?? null,
      latestNotes: this.latest?.notes ?? null,
      downloadPage: this.latest?.downloadPage ?? null,
      message: this.message,
    };
  }

  #set(status, message = '') {
    this.status = status;
    this.message = message;
    this.onChange();
  }

  /** Проверка сразу после запуска и потом раз в час. */
  startAutoCheck() {
    if (!this.installed || !this.updateUrl || this.timer) return;
    const tick = () => { void this.check().catch(() => {}); };
    setTimeout(tick, FIRST_CHECK_DELAY_MS).unref?.();
    this.timer = setInterval(tick, CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  async #fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetch(url, { signal: controller.signal, cache: 'no-store' });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Узнаёт у сервера аккаунтов свежую сборку. Возвращает состояние. */
  async check() {
    if (!this.installed || !this.updateUrl) return this.getState();
    if (['downloading', 'installing'].includes(this.status)) return this.getState();
    const previousStatus = this.status;
    this.#set('checking');
    try {
      const response = await this.#fetchWithTimeout(this.updateUrl, REQUEST_TIMEOUT_MS);
      if (response.status === 404) {
        this.latest = null;
        this.#set('idle');
        return this.getState();
      }
      if (!response.ok) throw new Error(`сервер обновлений ответил ${response.status}`);
      const manifest = await response.json();
      const build = Number(manifest?.build);
      if (!Number.isFinite(build) || build <= 0 || !manifest.url || !/^[0-9a-f]{64}$/.test(manifest.sha256 || '')) {
        throw new Error('описание сборки неполное');
      }
      this.latest = {
        ...manifest,
        build,
        url: new URL(manifest.url, this.updateUrl).toString(),
        downloadPage: manifest.downloadPage ? new URL(manifest.downloadPage, this.updateUrl).toString() : null,
      };
      const running = this.getRunningBuild();
      if (build <= running || this.readBadBuilds().includes(build)) {
        this.#set('idle');
      } else if (manifest.depsHash !== this.installed.depsHash) {
        // Новая начинка просит другие пакеты — поставить её поверх этих нельзя.
        this.#set('installer', 'Новая версия требует переустановки программы');
      } else {
        this.#set('available');
      }
    } catch (error) {
      this.log(`проверка обновлений: ${error?.message || error}`);
      // Нет связи — кнопку, если она уже была, не прячем.
      this.#set(previousStatus === 'available' || previousStatus === 'installer' ? previousStatus : 'idle');
    }
    return this.getState();
  }

  /**
   * Скачивает свежую сборку, сверяет отпечаток, раскладывает рядом и подменяет
   * папку разом. beforeSwap — остановить сервер: на Windows папку, из которой он
   * работает, не переименовать. Запустить его заново — дело вызывающего (main.js).
   */
  async install({ beforeSwap = async () => {} } = {}) {
    if (this.status !== 'available' || !this.latest) {
      await this.check();
      if (this.status !== 'available') throw new Error('Новой версии нет');
    }
    const latest = this.latest;
    await fs.mkdir(this.root, { recursive: true });
    const archive = path.join(this.root, `download-${latest.build}.tar.gz`);
    const next = path.join(this.root, `next-${Date.now()}`);
    try {
      this.#set('downloading', `Скачиваю сборку ${latest.build}…`);
      const response = await this.#fetchWithTimeout(latest.url, DOWNLOAD_TIMEOUT_MS);
      if (!response.ok || !response.body) throw new Error(`скачивание: ответ ${response.status}`);
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > MAX_BUNDLE_BYTES) throw new Error('файл обновления слишком большой');
      let received = 0;
      const counter = new TransformStream({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > MAX_BUNDLE_BYTES) {
            controller.error(new Error('файл обновления слишком большой'));
            return;
          }
          controller.enqueue(chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body.pipeThrough(counter)), createWriteStream(archive));

      const actual = await sha256File(archive);
      if (actual !== latest.sha256) throw new Error('отпечаток файла не совпал — файл повреждён');

      this.#set('installing', `Устанавливаю сборку ${latest.build}…`);
      await fs.mkdir(next, { recursive: true });
      await runTar(['-xzf', archive, '-C', next]);
      const unpacked = readBuildInfo(next);
      if (!unpacked || unpacked.build !== latest.build || unpacked.depsHash !== this.installed.depsHash) {
        throw new Error('в архиве не та сборка');
      }
      if (!existsSync(path.join(next, 'dist-server', 'server', 'index.js')) || !existsSync(path.join(next, 'dist', 'index.html'))) {
        throw new Error('в архиве нет интерфейса или сервера');
      }
      // Пакеты — из установки: ссылка вместо копии (на Windows — junction, прав администратора не нужно).
      await fs.symlink(path.join(this.appRoot, 'node_modules'), path.join(next, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir');

      await beforeSwap();
      const previous = path.join(this.root, 'previous');
      if (existsSync(this.currentDir)) {
        await fs.rm(previous, { recursive: true, force: true });
        await fs.rename(this.currentDir, previous);
      }
      await fs.rename(next, this.currentDir);
      this.log(`установлена сборка ${latest.build}`);
      this.#set('idle', `Обновлено до сборки ${latest.build}`);
      return latest.build;
    } catch (error) {
      await fs.rm(next, { recursive: true, force: true }).catch(() => {});
      this.#set('available', `Не удалось обновить: ${error?.message || error}`);
      throw error;
    } finally {
      await fs.rm(archive, { force: true }).catch(() => {});
    }
  }

  /** Сервер из скачанной начинки не запустился — больше её не берём, работаем на установленной. */
  async markActiveBad() {
    const active = readBuildInfo(this.currentDir);
    if (!active) return;
    const list = [...new Set([...this.readBadBuilds(), active.build])];
    await fs.mkdir(this.root, { recursive: true });
    await fs.writeFile(this.badBuildsPath, JSON.stringify(list), 'utf8');
    this.log(`сборка ${active.build} не запустилась — вернулся к установленной`);
    this.#set('idle', `Сборка ${active.build} не запустилась — работаю на прежней`);
  }
}
