import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';
import { Button, Input } from '../../../shared/view/ui';
import { browseFilesystemFolders } from '../data/workspaceApi';
import { getSuggestionRootPath } from '../utils/pathUtils';
import type { FolderSuggestion } from '../types';
import FolderBrowserModal from './FolderBrowserModal';
import { getDesktopBridge } from '../../../lib/desktopBridge';

type WorkspacePathFieldProps = {
  value: string;
  disabled?: boolean;
  onChange: (path: string) => void;
  onAdvanceToConfirm: () => void;
};

export default function WorkspacePathField({
  value,
  disabled = false,
  onChange,
  onAdvanceToConfirm,
}: WorkspacePathFieldProps) {
  const [pathSuggestions, setPathSuggestions] = useState<FolderSuggestion[]>([]);
  const [showPathDropdown, setShowPathDropdown] = useState(false);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const { t } = useTranslation();
  // Программа на компьютере: папку выбирают системным окном Mac/Windows.
  const desktop = getDesktopBridge();
  const [showManualPath, setShowManualPath] = useState(false);
  const pickWithSystemDialog = useCallback(async () => {
    const picked = await desktop?.pickFolder({ defaultPath: value || undefined });
    if (picked) onChange(picked);
  }, [desktop, onChange, value]);

  useEffect(() => {
    if (value.trim().length <= 2) {
      setPathSuggestions([]);
      setShowPathDropdown(false);
      return;
    }

    // Debounce path lookup to avoid firing a request for every keystroke.
    const timerId = window.setTimeout(async () => {
      try {
        const directoryPath = getSuggestionRootPath(value);
        const result = await browseFilesystemFolders(directoryPath);
        const normalizedInput = value.toLowerCase();

        const matchingSuggestions = result.suggestions
          .filter((suggestion) => {
            const normalizedSuggestion = suggestion.path.toLowerCase();
            return (
              normalizedSuggestion.startsWith(normalizedInput) &&
              normalizedSuggestion !== normalizedInput
            );
          })
          .slice(0, 5);

        setPathSuggestions(matchingSuggestions);
        setShowPathDropdown(matchingSuggestions.length > 0);
      } catch (error) {
        console.error('Failed to load path suggestions:', error);
      }
    }, 200);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [value]);

  const handleSuggestionSelect = useCallback(
    (suggestion: FolderSuggestion) => {
      onChange(suggestion.path);
      setShowPathDropdown(false);
    },
    [onChange],
  );

  const handleFolderSelected = useCallback(
    (selectedPath: string, advanceToConfirm: boolean) => {
      onChange(selectedPath);
      setShowFolderBrowser(false);
      if (advanceToConfirm) {
        onAdvanceToConfirm();
      }
    },
    [onAdvanceToConfirm, onChange],
  );

  if (desktop) {
    const folderName = value.split(/[\\/]/).filter(Boolean).pop() || value;
    return (
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => void pickWithSystemDialog()}
          disabled={disabled}
          className="flex w-full items-center gap-3 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-4 text-left transition-colors hover:border-primary/60 hover:bg-primary/5 disabled:opacity-60"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FolderOpen className="h-5 w-5" />
          </span>
          {value ? (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-foreground">{folderName}</span>
              <span className="block truncate text-xs text-muted-foreground">{value}</span>
            </span>
          ) : (
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-foreground">{t('projectWizard.desktop.pick')}</span>
              <span className="block text-xs text-muted-foreground">{t('projectWizard.desktop.pickHint')}</span>
            </span>
          )}
          {value && <span className="shrink-0 text-sm font-medium text-primary">{t('projectWizard.desktop.change')}</span>}
        </button>
        {showManualPath ? (
          <Input
            type="text"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={desktop.platform === 'win32' ? 'C:\\Users\\Имя\\Documents\\Проект' : '/Users/имя/Documents/Проект'}
            className="w-full"
            disabled={disabled}
            autoFocus
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowManualPath(true)}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {t('projectWizard.desktop.typePath')}
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="relative flex gap-2">
        <div className="relative flex-1">
          <Input
            type="text"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="/path/to/project/workspace"
            className="w-full"
            disabled={disabled}
          />

          {showPathDropdown && pathSuggestions.length > 0 && (
            <div className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
              {pathSuggestions.map((suggestion) => (
                <button
                  key={suggestion.path}
                  onClick={() => handleSuggestionSelect(suggestion)}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <div className="font-medium text-gray-900 dark:text-white">{suggestion.name}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">{suggestion.path}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <Button
          type="button"
          variant="outline"
          onClick={() => setShowFolderBrowser(true)}
          className="px-3"
          title="Browse folders"
          disabled={disabled}
        >
          <FolderOpen className="h-4 w-4" />
        </Button>
      </div>

      <FolderBrowserModal
        isOpen={showFolderBrowser}
        autoAdvanceOnSelect={false}
        onClose={() => setShowFolderBrowser(false)}
        onFolderSelected={handleFolderSelected}
      />
    </>
  );
}
