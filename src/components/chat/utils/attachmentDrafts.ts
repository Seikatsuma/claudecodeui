/**
 * Вложения черновика принадлежат ЧАТУ, как и его текст (см. draftScopeFor).
 *
 * Текст при смене чата прятался в свой чат, а картинки оставались в поле и
 * ехали в любой открытый следом чат. Егор 24.09.26: «если перенести — они
 * тянутся и в другой чат, отчего нельзя отправить сообщение, не удалив
 * изображения; а потом опять их грузить в первом чате».
 *
 * Хранилище — память страницы, не localStorage: браузерный File туда не
 * положить, а грузить картинки на сервер ради одного переключения чата — лишняя
 * работа и мусор в загрузках. Перезагрузку страницы вложения не переживают —
 * так же, как и до этой правки.
 */
export type AttachmentDraft = {
  /** Файлы, выбранные в этой вкладке и ещё не загруженные. */
  files: File[];
  /** Уже загруженные описания (вернулись в поле при правке сообщения из очереди). */
  uploaded: unknown[];
};

const drafts = new Map<string, AttachmentDraft>();

export function stashAttachmentDraft(scope: string | null, draft: AttachmentDraft): void {
  if (!scope) return;
  if (draft.files.length === 0 && draft.uploaded.length === 0) {
    drafts.delete(scope);
    return;
  }
  drafts.set(scope, { files: [...draft.files], uploaded: [...draft.uploaded] });
}

/** Достаёт вложения чата и убирает их из хранилища: дальше они живут в поле. */
export function takeAttachmentDraft(scope: string | null): AttachmentDraft {
  if (!scope) return { files: [], uploaded: [] };
  const draft = drafts.get(scope);
  drafts.delete(scope);
  return draft ?? { files: [], uploaded: [] };
}

export function clearAttachmentDraft(scope: string | null): void {
  if (!scope) return;
  drafts.delete(scope);
}
