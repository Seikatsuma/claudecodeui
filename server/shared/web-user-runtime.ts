/**
 * Кто из веб-пользователей запустил работу — и в какой каталог настроек ему
 * при этом можно писать.
 *
 * Раньше этот расчёт жил внутри чат-вебсокета и больше нигде. Встроенный
 * терминал открывался вообще без него: процесс оболочки наследовал окружение
 * сервера целиком, а значит и `CLAUDE_CONFIG_DIR` — то есть общий каталог
 * `~/.claude`, принадлежащий владельцу площадки.
 *
 * 12.09.26 это выстрелило: новый пользователь зашёл по приглашению, открыл
 * терминал, выполнил `/login` — и его вход лёг поверх входа владельца. У
 * владельца в Claude Code сменился аккаунт, а сам новый пользователь при этом
 * на платформе так и числился неподключённым: интерфейс спрашивал про его
 * собственный каталог, где было пусто.
 *
 * Поэтому расчёт теперь один и общий. Правило простое: на площадке с открытой
 * регистрацией у каждого свой каталог, и работа, для которой каталог
 * определить не удалось, не начинается вовсе — молча писать в чужой каталог
 * хуже, чем отказать.
 */

import path from 'node:path';

import { credentialsDb, userDb } from '@/modules/database/index.js';
import { getGlobalImageAssetsDir } from '@/shared/image-attachments.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';
import { isPlatformOwnerWebUser, OPEN_REGISTRATION } from '@/shared/utils.js';
import { getWebUserClaudeConfigDir } from '@/shared/web-user-paths.js';

// Проверки доступа живут без базы данных, чтобы их можно было испытать отдельно.
export { hasOwnClaudeAccess, withoutInheritedClaudeAuth } from '@/shared/claude-login.js';

const ANTHROPIC_API_KEY_CREDENTIAL_TYPE = 'anthropic_api_key';

export type WebUserRuntimeContext = {
  claudeConfigDir: string | null;
  anthropicApiKey: string | null;
  /**
   * Не отдавать процессу ключи Claude из окружения сервера. Они принадлежат
   * владельцу площадки, а CLI предпочитает ключ из окружения входу из папки:
   * гость, вошедший своей подпиской, молча работал бы на ключе владельца.
   */
  isolateInheritedClaudeAuth: boolean;
};

const EMPTY_CONTEXT: WebUserRuntimeContext = {
  claudeConfigDir: null,
  anthropicApiKey: null,
  isolateInheritedClaudeAuth: false,
};



/**
 * Достаёт опознанного пользователя из соединения. Форматы разные, потому что
 * их пишут два разных контура входа — платформенный и открытый.
 */
export function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined,
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

/**
 * Каталог настроек и ключ этого пользователя.
 *
 * Возвращает пустые значения, когда открытая регистрация выключена (тогда
 * площадка одноаккаунтная и правильное поведение — наследовать окружение
 * процесса, как было всегда) либо когда пользователь не опознан.
 */
export function resolveWebUserRuntimeContext(
  userId: string | number | null,
): WebUserRuntimeContext {
  if (!OPEN_REGISTRATION || userId === null) {
    return EMPTY_CONTEXT;
  }

  const numericUserId = Number(userId);
  if (!Number.isFinite(numericUserId)) {
    return EMPTY_CONTEXT;
  }

  // Владелец площадки — единственный, у кого два настоящих аккаунта и
  // переключатель между ними. Остальные всегда в своём единственном каталоге.
  const isOwner = isPlatformOwnerWebUser(numericUserId);
  const ownerSlot = isOwner
    ? userDb.getActiveOwnerAccountSlot(numericUserId)
    : undefined;

  return {
    claudeConfigDir: getWebUserClaudeConfigDir(numericUserId, ownerSlot),
    anthropicApiKey: credentialsDb.getActiveCredential(
      numericUserId,
      ANTHROPIC_API_KEY_CREDENTIAL_TYPE,
    ),
    isolateInheritedClaudeAuth: !isOwner,
  };
}

/**
 * Куда этот пользователь складывает загруженные картинки и файлы.
 *
 * Склад был один на всех: `~/.cloudcli/assets`. Имена там случайные, наугад
 * чужой файл не назовёшь, но это не разделение, а его отсутствие с оговоркой.
 * Егор 12.09.26: «нужно полное разделение, это совершенно другой аккаунт,
 * ничего общего».
 *
 * Теперь у каждого своя полка: `~/.cloudcli/assets/u<id>`. На площадке без
 * открытой регистрации склад остаётся прежним — там пользователь один.
 */
export function getImageAssetsDirForUser(userId: string | number | null): string {
  const root = getGlobalImageAssetsDir();
  if (!OPEN_REGISTRATION || userId === null) {
    return root;
  }
  const numericUserId = Number(userId);
  if (!Number.isFinite(numericUserId)) {
    return root;
  }
  return path.join(root, `u${numericUserId}`);
}

/**
 * Откуда этому пользователю МОЖНО читать.
 *
 * Писать всегда только на свою полку, но у владельца площадки есть прошлое:
 * картинки его прежних разговоров лежат в корне склада, и путь к ним записан
 * в истории чатов. Отрезать корень значило бы превратить картинки в старых
 * разговорах в битые квадраты. Поэтому владельцу корень остаётся доступен на
 * чтение — и только ему, и только на чтение.
 *
 * Полка другого пользователя не попадает в этот список никогда: корень
 * разрешается точным совпадением каталога, а не «всё, что внутри».
 */
export function getReadableImageAssetsDirs(userId: string | number | null): string[] {
  const own = getImageAssetsDirForUser(userId);
  const root = getGlobalImageAssetsDir();
  if (own === root) {
    return [root];
  }
  const numericUserId = Number(userId);
  return isPlatformOwnerWebUser(numericUserId) ? [own, root] : [own];
}
