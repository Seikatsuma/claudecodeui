import { Undo2 } from 'lucide-react';

/**
 * Кнопка «Вернуться сюда» под своим сообщением — рядом с копированием.
 *
 * Сама ничего не решает: сообщает наверх, к какому сообщению человек хочет
 * вернуться. Подтверждение, запрос к серверу и текст в поле ввода — забота
 * экрана чата (ChatInterface). Видна всегда, и на телефоне тоже: наводить
 * там нечем, а спрятанную кнопку не найти.
 */
type Props = {
  onRewind: () => void;
  disabled?: boolean;
};

export default function MessageRewindControl({ onRewind, disabled = false }: Props) {
  return (
    <button
      type="button"
      onClick={onRewind}
      disabled={disabled}
      title="Вернуться к этому сообщению: всё после него уберётся, текст вернётся в поле ввода"
      aria-label="Вернуться к этому сообщению"
      className="inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
    >
      <Undo2 className="h-3.5 w-3.5" />
      <span>Вернуться</span>
    </button>
  );
}
