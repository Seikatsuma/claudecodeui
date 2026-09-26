import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CornerDownLeft, PencilLine, Square, Undo2 } from 'lucide-react';

/**
 * Окно подтверждения «Back» — возврата чата к своему сообщению.
 *
 * Раньше спрашивало системное окно телефона: сплошной абзац и две мелкие
 * ссылки Cancel / OK (Егор 26.09.26: «пусть окно будет понятнее и две большие
 * кнопки снизу»). Здесь — цитата сообщения, три коротких пункта, что
 * произойдёт, и две большие кнопки на всю ширину.
 *
 * `fixed inset-0` через портал — как у остальных окон: общее правило
 * `html.keyboard-open .fixed.inset-0` (index.css) держит его над клавиатурой iPhone.
 */
type Props = {
  text: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
};

export default function RewindConfirmDialog({ text, busy, error, onCancel, onConfirm }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={() => { if (!busy) onCancel(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rewind-dialog-title"
        className="w-full max-w-md rounded-2xl border border-border bg-background p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <Undo2 className="h-5 w-5" />
          </div>
          <h2 id="rewind-dialog-title" className="text-lg font-semibold text-foreground">
            Вернуться к этому сообщению?
          </h2>
        </div>

        {text.trim() && (
          <div className="mt-4 line-clamp-3 whitespace-pre-wrap break-words rounded-xl border border-border/60 bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
            {text.trim()}
          </div>
        )}

        <ul className="mt-4 space-y-3 text-[15px] leading-snug text-foreground">
          <li className="flex gap-3">
            <CornerDownLeft className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
            <span>Это сообщение и всё, что было после него, уберётся из чата.</span>
          </li>
          <li className="flex gap-3">
            <PencilLine className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
            <span>Текст вернётся в поле ввода — поправьте и отправьте заново.</span>
          </li>
          <li className="flex gap-3">
            <Square className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
            <span>Если агент сейчас работает, он остановится.</span>
          </li>
        </ul>

        <p className="mt-4 text-xs text-muted-foreground">
          Файлы, которые агент уже успел изменить, останутся как есть.
        </p>

        {error && (
          <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</p>
        )}

        <div className="mt-5 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="h-12 rounded-xl border border-border bg-muted text-base font-medium text-foreground transition-colors hover:bg-muted/70 disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="h-12 rounded-xl bg-blue-600 text-base font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
          >
            {busy ? 'Возвращаю…' : 'Вернуться'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
