import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';

import { api } from '../../../utils/api';
import { DEVIN_ACCOUNT_CHANGED_EVENT, switchChatProvider } from '../../../hooks/useCodexAccount';

type DevinLoginModalProps = {
  onClose: () => void;
};

type Step =
  | { kind: 'loading' }
  | { kind: 'ready'; url: string }
  | { kind: 'sending'; url: string }
  | { kind: 'done'; name: string | null }
  | { kind: 'error'; message: string };

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } | string; message?: string };
    if (typeof body.error === 'string') return body.error;
    return body.error?.message ?? body.message ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Вход во второй аккаунт Devin из меню аккаунтов (Егор 07.10.26: «стабильная
 * ссылка … я скинул код и всё работало»). Ссылку входа Devin выдаёт одноразовую
 * и привязывает к запущенному на сервере процессу, поэтому «стабильна» кнопка:
 * окно при каждом открытии запускает свежий вход. Шаги — без терминала: открыть
 * ссылку, вставить код, готово (планка iPad: первый шаг без терминала).
 */
export default function DevinLoginModal({ onClose }: DevinLoginModalProps) {
  const [step, setStep] = useState<Step>({ kind: 'loading' });
  const [code, setCode] = useState('');
  const finished = useRef(false);

  const start = useCallback(async () => {
    setStep({ kind: 'loading' });
    setCode('');
    try {
      const response = await api.user.devinLoginStart();
      if (!response.ok) {
        setStep({ kind: 'error', message: await readErrorMessage(response, 'Не удалось получить ссылку входа.') });
        return;
      }
      const body = (await response.json()) as { url?: string };
      if (!body.url) {
        setStep({ kind: 'error', message: 'Devin не выдал ссылку входа.' });
        return;
      }
      setStep({ kind: 'ready', url: body.url });
    } catch {
      setStep({ kind: 'error', message: 'Нет связи с сервером. Попробуйте ещё раз.' });
    }
  }, []);

  useEffect(() => {
    void start();
    return () => {
      // Окно закрыли, не закончив вход — процесс входа на сервере не держим.
      if (!finished.current) {
        void api.user.devinLoginCancel().catch(() => undefined);
      }
    };
  }, [start]);

  const submit = async () => {
    if (step.kind !== 'ready' || !code.trim()) return;
    const { url } = step;
    setStep({ kind: 'sending', url });
    try {
      const response = await api.user.devinLoginCode(code.trim());
      if (!response.ok) {
        setStep({ kind: 'error', message: await readErrorMessage(response, 'Не удалось отправить код.') });
        return;
      }
      const body = (await response.json()) as { ok?: boolean; name?: string | null; message?: string };
      if (body.ok) {
        finished.current = true;
        setStep({ kind: 'done', name: body.name ?? null });
        window.dispatchEvent(new Event(DEVIN_ACCOUNT_CHANGED_EVENT));
        switchChatProvider('devin');
        return;
      }
      setStep({ kind: 'error', message: body.message ?? 'Код не подошёл.' });
    } catch {
      setStep({ kind: 'error', message: 'Нет связи с сервером. Попробуйте ещё раз.' });
    }
  };

  const paste = async () => {
    try {
      setCode((await navigator.clipboard.readText()).trim());
    } catch {
      // Буфер недоступен — человек вставит вручную.
    }
  };

  const canType = step.kind === 'ready' || step.kind === 'sending';
  const url = step.kind === 'ready' || step.kind === 'sending' ? step.url : null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-label="Добавить аккаунт Devin"
        className="w-full max-w-md rounded-xl border border-border bg-popover p-5 text-foreground shadow-xl"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h3 className="text-base font-semibold">Добавить аккаунт Devin</h3>
          <button type="button" onClick={onClose} aria-label="Закрыть" className="text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        {step.kind === 'done' ? (
          <div className="space-y-4">
            <p className="text-sm">
              Готово: аккаунт подключён{step.name ? <> — <b>{step.name}</b></> : null}. Новые чаты Devin пойдут через него.
            </p>
            <button type="button" onClick={onClose} className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground">
              Закрыть
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-medium">1. Откройте страницу входа и войдите в нужный аккаунт Devin</p>
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground"
                >
                  Открыть страницу входа <ExternalLink className="h-4 w-4" />
                </a>
              ) : (
                <div className="w-full rounded-lg bg-muted px-4 py-3 text-center text-sm text-muted-foreground">
                  {step.kind === 'loading' ? 'Готовлю ссылку…' : 'Ссылки нет'}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">2. Скопируйте код со страницы и вставьте сюда</p>
              <div className="flex gap-2">
                <input
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  disabled={!canType || step.kind === 'sending'}
                  placeholder="Код со страницы входа"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-3 text-base"
                />
                <button
                  type="button"
                  onClick={() => void paste()}
                  disabled={!canType || step.kind === 'sending'}
                  className="flex-shrink-0 rounded-lg border border-border px-3 py-3 text-sm"
                >
                  Вставить
                </button>
              </div>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={step.kind !== 'ready' || !code.trim()}
                className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {step.kind === 'sending' ? 'Проверяю код…' : 'Войти'}
              </button>
            </div>

            {step.kind === 'error' && (
              <div className="space-y-2">
                <p className="text-sm text-destructive">{step.message}</p>
                <button
                  type="button"
                  onClick={() => void start()}
                  className="w-full rounded-lg border border-border px-4 py-3 text-sm font-medium"
                >
                  Новая ссылка
                </button>
              </div>
            )}
            {step.kind === 'ready' && (
              <button type="button" onClick={() => void start()} className="text-xs text-muted-foreground underline">
                Новая ссылка
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
