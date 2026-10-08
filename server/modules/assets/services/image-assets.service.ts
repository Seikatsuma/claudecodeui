import fsSync, { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

import mime from 'mime-types';

import { ensureJpegForHeic, isHeicLikePath, toPosixPath } from '@/shared/image-attachments.js';
import { getRequestRuntimeContext } from '@/shared/request-context.js';
import { getImageAssetsDirForUser, getReadableImageAssetsDirs } from '@/shared/web-user-runtime.js';

/**
 * Image mime types accepted for chat attachment uploads. SVG is allowed for
 * storage/preview even though some providers (Claude API) skip it at send time.
 * HEIC/HEIF принимаем тоже: телефон снимает экран в этом формате — на записи
 * он сразу конвертируется в jpeg (convertHeicAttachmentRecords), иначе снимок
 * уезжает в «файл» и в ленте висит именем файла вместо картинки.
 */
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/heic',
  'image/heif',
]);

// Used only by this service and the assets routes via the barrel file.
type StoredImageAsset = {
  /** Original upload filename, for display. */
  name: string;
  /** Absolute posix-normalized path inside the global assets folder. */
  path: string;
  size: number;
  mimeType: string;
};

// Shape of one multer-stored file; kept local because only this module reads it.
type UploadedImageFile = {
  originalname: string;
  filename: string;
  size: number;
  mimetype: string;
};

type UploadedAttachmentFile = UploadedImageFile;

/**
 * Полка склада того, кто сейчас обратился.
 *
 * Все три места ниже — создание папки, запись пути в карточку вложения и
 * выдача файла по ссылке — раньше звали один общий каталог. Теперь каждое
 * спрашивает полку текущего пользователя; для площадки с одним пользователем
 * ответ прежний.
 */
function currentUserAssetsDir(): string {
  return getImageAssetsDirForUser(getRequestRuntimeContext()?.userId ?? null);
}

/** Returns whether one uploaded mime type may be stored as a chat image asset. */
export function isAllowedImageMimeType(mimeType: string): boolean {
  return ALLOWED_IMAGE_MIME_TYPES.has(mimeType);
}

/** Creates the global `~/.cloudcli/assets` folder if needed and returns it. */
export async function ensureImageAssetsDir(): Promise<string> {
  const assetsDir = currentUserAssetsDir();
  await fs.mkdir(assetsDir, { recursive: true });
  return assetsDir;
}

/**
 * Maps multer-stored upload files to the attachment records returned to the
 * chat composer. The absolute path is what providers receive and what session
 * history carries back to the UI.
 */
export function buildStoredImageRecords(files: UploadedImageFile[]): StoredImageAsset[] {
  const assetsDir = currentUserAssetsDir();
  return files.map((file) => ({
    name: file.originalname,
    path: toPosixPath(path.join(assetsDir, file.filename)),
    size: file.size,
    mimeType: file.mimetype,
  }));
}

/**
 * Maps multer-stored files to provider-neutral attachment records for the
 * assets route. The shared storage format intentionally matches image records
 * so one uploaded file can move through queueing and provider dispatch.
 */
export function buildStoredAttachmentRecords(files: UploadedAttachmentFile[]): StoredImageAsset[] {
  return buildStoredImageRecords(files);
}

/**
 * HEIC-записи заменяет на свежесконвертированный jpeg-вариант: телефон шлёт
 * снимки экрана в heic, без конвертации они едут файлами — в ленте карточка
 * «File attachment» вместо снимка, а провайдер не может посмотреть картинку
 * (HEIC не входит в принимаемые форматы изображений ни у кого). Конвертация
 * не удалась — запись остаётся исходной, вложение просто показывается как
 * файл, как раньше.
 *
 * Вызывают оба приёмных маршрута (/images и /files) — телефон шлёт heic
 * через общий приёмник.
 */
export async function convertHeicAttachmentRecords(records: StoredImageAsset[]): Promise<StoredImageAsset[]> {
  return Promise.all(records.map(async (record) => {
    if (!isHeicLikePath(record.path)) {
      return record;
    }
    const jpegPath = await ensureJpegForHeic(record.path);
    if (!jpegPath) {
      return record;
    }
    const stat = await fs.stat(jpegPath).catch(() => null);
    return {
      ...record,
      path: toPosixPath(jpegPath),
      mimeType: 'image/jpeg',
      size: stat?.size ?? record.size,
    };
  }));
}

/**
 * Resolves one asset filename to its absolute path inside the global assets
 * folder, or null when the name is empty, contains path separators/traversal,
 * or would escape the folder. This is the only lookup the serving route uses,
 * so nothing outside `~/.cloudcli/assets` can ever be read through it.
 */
export function resolveImageAssetFile(filename: string): string | null {
  const trimmed = typeof filename === 'string' ? filename.trim() : '';
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    return null;
  }

  // Полок может быть две: своя и — только у владельца площадки — старый общий
  // корень, где лежат картинки его прежних разговоров. Имя уже проверено на
  // отсутствие разделителей, поэтому найтись может лишь ПРЯМОЙ ребёнок
  // каталога: полка другого пользователя лежит папкой и под это не подходит.
  for (const directory of getReadableImageAssetsDirs(getRequestRuntimeContext()?.userId ?? null)) {
    const assetsDir = path.resolve(directory);
    const resolved = path.resolve(assetsDir, trimmed);
    if (!resolved.startsWith(assetsDir + path.sep)) {
      continue;
    }
    if (existsSync(resolved)) {
      return resolved;
    }
  }

  // Ничего не нашлось: возвращаем путь на своей полке, чтобы вызывающий
  // отличил «файла нет» от «имя недопустимо».
  const ownDir = path.resolve(currentUserAssetsDir());
  const ownResolved = path.resolve(ownDir, trimmed);
  return ownResolved.startsWith(ownDir + path.sep) ? ownResolved : null;
}

/**
 * Resolves a general chat attachment for the assets serving route. It shares
 * the image resolver's strict direct-child containment boundary.
 */
export function resolveAttachmentAssetFile(filename: string): string | null {
  return resolveImageAssetFile(filename);
}

/**
 * Opens one stored chat asset for the assets route without exposing arbitrary
 * filesystem reads. The route translates the lookup status and streams the
 * returned direct-child file to the authenticated client.
 */
export async function openStoredAttachmentAsset(filename: string) {
  const resolved = resolveAttachmentAssetFile(filename);
  if (!resolved) {
    return { status: 'invalid' as const };
  }

  try {
    await fs.access(resolved);
  } catch {
    return { status: 'missing' as const };
  }

  return {
    status: 'found' as const,
    contentType: mime.lookup(resolved) || 'application/octet-stream',
    stream: fsSync.createReadStream(resolved),
  };
}
