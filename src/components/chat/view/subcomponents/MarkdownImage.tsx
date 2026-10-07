import { useState } from 'react';

import type { ChatImage } from '../../types/types';
import { useChatImageSrc } from '../../utils/useChatImageSrc';

import { ImageLightbox } from './ChatMessageImages';

/**
 * `![alt](src)` внутри ответа агента. Три вида источников:
 * - `/api/assets/images/<имя>` — защищённый маршрут чата; голый <img src> не
 *   несёт токен в заголовке, поэтому картинка тянется blob'ом через
 *   `useChatImageSrc`, как вложения сообщений. Голое имя файла (`shot.png`)
 *   считаем тем же именем в хранилище — такую строку проще написать агенту
 *   после `chat-image.sh`;
 * - `data:` / `blob:` / `https?:` — обычный <img> без авторизации;
 * - всё прочее — подпись (alt), чтобы не рисовать пустую рамку битой ссылки.
 */

// Имя файла внутри адреса хранилища; по этому базовому имени useChatImageSrc
// собирает тот же маршрут обратно.
const ASSETS_ROUTE_PATTERN = /^\/api\/assets\/images\/([^/?#]+)/;
// `shot.png` без разделителей пути — терпимое написание имени в хранилище.
const BARE_IMAGE_NAME_PATTERN = /^[^\s/?#]+\.(?:png|jpe?g|gif|webp|svg)$/i;

function ProtectedMarkdownImage({ image, alt }: { image: ChatImage; alt: string }) {
  const { src, failed } = useChatImageSrc(image);
  const [expanded, setExpanded] = useState(false);

  if (failed) {
    return (
      <span className="my-2 block max-w-md rounded-xl border border-border/50 bg-muted px-3 py-2 text-xs text-muted-foreground">
        {alt}
      </span>
    );
  }

  if (!src) {
    return <span className="my-2 block h-40 w-full max-w-md animate-pulse rounded-xl border border-border/50 bg-muted" />;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-label={`Expand ${alt}`}
        className="my-2 block overflow-hidden rounded-xl border border-border/50 shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/60"
      >
        <img
          src={src}
          alt={alt}
          className="block max-h-80 w-auto max-w-full cursor-zoom-in object-contain"
        />
      </button>
      {expanded && <ImageLightbox src={src} alt={alt} onClose={() => setExpanded(false)} />}
    </>
  );
}

// `node` деструктурируем наружу: hast-узел react-markdown не должен уехать в DOM.
export function MarkdownImage({ node: _node, src, alt }: { node?: unknown; src?: string; alt?: string }) {
  const label = (alt ?? '').trim() || 'Изображение';
  const trimmed = (src ?? '').trim();
  if (!trimmed) {
    return <span>{label}</span>;
  }

  const assetMatch = ASSETS_ROUTE_PATTERN.exec(trimmed);
  if (assetMatch) {
    let name = assetMatch[1];
    try {
      name = decodeURIComponent(name);
    } catch {
      // Кривое кодирование — оставляем имя как есть.
    }
    return <ProtectedMarkdownImage image={{ path: name }} alt={label} />;
  }

  if (BARE_IMAGE_NAME_PATTERN.test(trimmed)) {
    return <ProtectedMarkdownImage image={{ path: trimmed }} alt={label} />;
  }

  if (/^(?:https?|data|blob):/i.test(trimmed)) {
    return (
      <img
        src={trimmed}
        alt={label}
        loading="lazy"
        referrerPolicy="no-referrer"
        className="my-2 block max-h-80 max-w-full rounded-xl border border-border/50 object-contain shadow-sm"
      />
    );
  }

  return <span>{label}</span>;
}
