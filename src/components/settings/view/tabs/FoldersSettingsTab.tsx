import { useCallback, useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';

import { getDesktopBridge } from '../../../../lib/desktopBridge';
import { authenticatedFetch } from '../../../../utils/api';
import { Button } from '../../../../shared/view/ui';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';

/**
 * «Папки» — только в программе на компьютере (сервер: modules/desktop/desktop-settings.ts).
 * Вопрос Ричарда 28.09.26: «как поменять, откуда он берёт данные — хочу рабочую папку,
 * чтобы не захламлять диск C; он подтянул мои проекты из Codex; в настройках не нашёл».
 */

type DesktopFolderSettings = {
  workFolder: string | null;
  showOtherAgents: boolean;
  historyFolder: string;
};

const request = async (init?: RequestInit): Promise<DesktopFolderSettings> => {
  const response = await authenticatedFetch('/api/desktop/settings', init);
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) throw new Error(body?.error || 'Не получилось сохранить — попробуйте ещё раз.');
  return body.data as DesktopFolderSettings;
};

const formatSize = (mb: number | null): string => {
  if (mb === null) return 'много файлов — размер не успел посчитаться';
  if (mb >= 1024) return `${(Math.round((mb / 1024) * 10) / 10).toString().replace('.', ',')} ГБ`;
  return `${Math.max(mb, 0.1).toString().replace('.', ',')} МБ`;
};

export default function FoldersSettingsTab() {
  const [settings, setSettings] = useState<DesktopFolderSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // undefined — ещё считаю, null — не успел посчитать (очень много файлов).
  const [historySizeMb, setHistorySizeMb] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    request().then(setSettings).catch((reason: Error) => setError(reason.message));
    authenticatedFetch('/api/desktop/history-size')
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => setHistorySizeMb(body?.data ? body.data.historySizeMb : null))
      .catch(() => setHistorySizeMb(null));
  }, []);

  const save = useCallback(async (patch: Partial<Pick<DesktopFolderSettings, 'workFolder' | 'showOtherAgents'>>) => {
    setBusy(true);
    setError(null);
    try {
      setSettings(await request({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const chooseWorkFolder = useCallback(async () => {
    const picked = await getDesktopBridge()?.pickFolder({ defaultPath: settings?.workFolder || undefined });
    if (picked) await save({ workFolder: picked });
  }, [save, settings?.workFolder]);

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Рабочая папка"
        description="Claude работает в папке, которую вы открыли слева кнопкой «+»: всё, что он создаёт, ложится туда. Выйти за её пределы он может только с вашего разрешения."
      >
        <SettingsCard>
          <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">
                {!settings ? 'Узнаю…' : settings.workFolder ? (
                  <span className="break-all font-mono text-[13px]">{settings.workFolder}</span>
                ) : 'Не выбрана'}
              </div>
              <div className="mt-0.5 text-sm text-muted-foreground">
                {!settings ? '' : settings.workFolder
                  ? 'С неё начинается окно выбора, когда вы нажимаете «+». Внутри можно завести папку под каждую задачу.'
                  : 'Сейчас окно выбора начинается с «Документов». Выберите папку, например на диске D, — дальше «+» будет открываться в ней.'}
              </div>
            </div>
            <Button type="button" variant="outline" size="sm" disabled={busy || !settings} onClick={() => void chooseWorkFolder()} className="shrink-0">
              <FolderOpen className="mr-2 h-4 w-4" />
              {settings?.workFolder ? 'Сменить' : 'Выбрать папку'}
            </Button>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Что показывать слева">
        <SettingsCard>
          <SettingsRow
            label="Чаты из Codex и других программ"
            description="Переписка Codex, Cursor и других помощников на этом компьютере. Выключено — слева только папки, открытые здесь, и чаты Claude. Сами чаты и файлы не трогаются."
          >
            <SettingsToggle
              checked={Boolean(settings?.showOtherAgents)}
              onChange={(value) => void save({ showOtherAgents: value })}
              ariaLabel="Показывать чаты из Codex и других программ"
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      {settings && (
        <SettingsSection title="История переписки">
          <SettingsCard>
            <div className="px-4 py-4 text-sm">
              <div className="text-foreground">
                Занимает <span className="font-semibold">{historySizeMb === undefined ? 'считаю…' : formatSize(historySizeMb)}</span>
              </div>
              <div className="mt-0.5 text-muted-foreground">
                Её хранит сам Claude в своей служебной папке, рядом со входом в подписку, и ищет только там — перенести её на другой диск программа не может:
              </div>
              <div className="mt-1 break-all font-mono text-[12px] text-muted-foreground">{settings.historyFolder}</div>
            </div>
          </SettingsCard>
        </SettingsSection>
      )}

      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}
