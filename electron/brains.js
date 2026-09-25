import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * «Мозги» программы: правила, протокол, помощники и навыки.
 *
 * Рабочая копия всегда в <userData>/brains/current — на неё смотрит сервер
 * интерфейса (CLAUDE_UI_BRAINS_DIR) и перечитывает при смене manifest.json,
 * так что свежая версия с сервера аккаунтов действует со следующего сообщения
 * без перезапуска. Вложенная в программу копия — стартовая: кладётся в
 * current при первом запуске и когда она новее скачанной.
 */
export class BrainsManager {
  constructor({ bundledDir, userDataDir, log = () => {} }) {
    this.bundledDir = bundledDir;
    this.currentDir = path.join(userDataDir, 'brains', 'current');
    this.log = log;
  }

  static readVersion(dir) {
    try {
      return JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version || null;
    } catch {
      return null;
    }
  }

  getActiveDir() {
    return this.currentDir;
  }

  getVersion() {
    return BrainsManager.readVersion(this.currentDir);
  }

  /** Кладёт вложенную копию, если рабочей нет или она старее. */
  async ensureInstalled() {
    const bundledVersion = BrainsManager.readVersion(this.bundledDir);
    const currentVersion = this.getVersion();
    if (!bundledVersion) return;
    if (currentVersion && currentVersion >= bundledVersion && existsSync(path.join(this.currentDir, 'CLAUDE.md'))) {
      return;
    }
    await this.#replaceWith(async (dir) => {
      await fs.cp(this.bundledDir, dir, { recursive: true });
    });
    this.log(`мозги из программы: ${bundledVersion}`);
  }

  /** Берёт свежую версию с сервера аккаунтов, если она новее рабочей. */
  async syncFromServer(fetchBrains) {
    const payload = await fetchBrains();
    const version = payload?.version;
    if (!version || !payload.files || typeof payload.files !== 'object') return false;
    const currentVersion = this.getVersion();
    if (currentVersion && currentVersion >= version) return false;

    await this.#replaceWith(async (dir) => {
      for (const [rel, content] of Object.entries(payload.files)) {
        const target = path.resolve(dir, rel);
        // Только внутрь папки мозгов: ни абсолютных путей, ни «..».
        if (!target.startsWith(path.resolve(dir) + path.sep) || typeof content !== 'string') {
          throw new Error(`неверный путь в мозгах: ${rel}`);
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, 'utf8');
      }
      await fs.writeFile(path.join(dir, 'manifest.json'),
        JSON.stringify({ version, built_at: payload.built_at || null }, null, 2), 'utf8');
    });
    this.log(`мозги с сервера: ${version}`);
    return true;
  }

  // Собираем рядом и подменяем папку целиком: полусобранные мозги сервер не увидит.
  // Прежняя версия остаётся в brains/previous (одна, более старые — служебный кэш программы).
  async #replaceWith(fill) {
    const root = path.dirname(this.currentDir);
    const next = path.join(root, `next-${Date.now()}`);
    const previous = path.join(root, 'previous');
    await fs.mkdir(root, { recursive: true });
    await fill(next);
    if (existsSync(this.currentDir)) {
      if (existsSync(previous)) {
        await fs.rm(previous, { recursive: true, force: true });
      }
      await fs.rename(this.currentDir, previous);
    }
    await fs.rename(next, this.currentDir);
  }
}
