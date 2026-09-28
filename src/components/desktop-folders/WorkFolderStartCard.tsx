import { FolderHeart } from 'lucide-react';
import { useState } from 'react';

import { isDesktopApp } from '../../lib/desktopBridge';

import { chooseWorkFolder, useWorkFolder } from './workFolderStore';

/**
 * Первый экран программы на компьютере, пока главная папка не выбрана: одно
 * предложение и одна кнопка (планка «как iPad»). Выбрал — папка встаёт слева,
 * в ней сразу новый чат, а Claude раскладывает всё по полкам внутри неё.
 */
export default function WorkFolderStartCard() {
  const { loaded, workFolder } = useWorkFolder();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!isDesktopApp() || !loaded || workFolder) return null;

  return (
    <div className="mx-auto mb-6 w-full max-w-xl rounded-2xl border border-primary/20 bg-primary/5 p-5 text-left">
      <div className="flex items-start gap-3">
        <FolderHeart className="mt-0.5 h-6 w-6 flex-shrink-0 text-primary" />
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">Где Claude будет хранить всё?</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Выберите одну главную папку, например на диске D. Claude будет работать в ней и сам раскладывать по полкам:
            у каждого проекта — своя папка, заметки о людях и темах — отдельно. Новые проекты появятся слева сами.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              chooseWorkFolder().catch((reason: Error) => setError(reason.message)).finally(() => setBusy(false));
            }}
            className="mt-3 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            Выбрать главную папку
          </button>
          {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
        </div>
      </div>
    </div>
  );
}
