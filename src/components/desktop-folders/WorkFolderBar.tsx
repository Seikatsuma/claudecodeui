import { FolderOpen } from 'lucide-react';
import { useState } from 'react';

import { chooseWorkFolder, describeFolder, openFolderPicker, useWorkFolder } from './workFolderStore';

/**
 * Строка над полем ввода (программа на компьютере): в какой папке сейчас работает
 * Claude — и сменить. Егор 28.09.26: «показывал, в какой папке он сейчас работает,
 * и потом предложение выбрать папку».
 */
export default function WorkFolderBar({ projectPath }: { projectPath: string }) {
  const { loaded, workFolder } = useWorkFolder();
  const [error, setError] = useState<string | null>(null);
  if (!loaded || !projectPath) return null;
  const { label } = describeFolder(projectPath, workFolder);

  return (
    <div className="mx-auto mb-2 flex max-w-[54.25rem] flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-muted-foreground">
      <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="flex-shrink-0">Claude работает в папке</span>
      <span title={projectPath} className="min-w-0 max-w-full truncate font-medium text-foreground">{label}</span>
      <span aria-hidden="true">·</span>
      {workFolder ? (
        <button type="button" onClick={openFolderPicker} className="underline underline-offset-2 hover:text-foreground">
          Другая папка
        </button>
      ) : (
        <button
          type="button"
          onClick={() => { setError(null); chooseWorkFolder().catch((reason: Error) => setError(reason.message)); }}
          className="underline underline-offset-2 hover:text-foreground"
        >
          Выбрать главную папку — там Claude будет хранить всё
        </button>
      )}
      {error && <span className="w-full text-red-500">{error}</span>}
    </div>
  );
}
