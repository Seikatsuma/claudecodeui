import { ClipboardPaste, KeyRound, Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { extractLoginLinkToken } from '../loginLinkToken';

import AuthScreenLayout from './AuthScreenLayout';

type NoInvitationScreenProps = {
  loginLinkRejected?: boolean;
};

/**
 * Shown at the bare root address when the visitor has no session and no
 * `/invite/<token>` link.
 *
 * It used to be a plain dead end: a sentence telling you to go find your link,
 * with nothing to do on the page. That is exactly where people landed after
 * opening the app from a home-screen icon - the icon starts at "/", and a
 * standalone web app has its own storage, so no session from the browser is
 * visible there. The primary action reads a copied link after an explicit
 * click. Browsers that deny clipboard access still get the manual field as a
 * fallback, but it no longer occupies the normal screen.
 */
export default function NoInvitationScreen({ loginLinkRejected = false }: NoInvitationScreenProps) {
  const { t } = useTranslation('auth');
  const [link, setLink] = useState('');
  const [manualEntryOpen, setManualEntryOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isReadingClipboard, setIsReadingClipboard] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const enterWith = (rawLink: string, allowBareToken = false): boolean => {
    const token = extractLoginLinkToken(rawLink, allowBareToken);
    if (!token) {
      return false;
    }

    // A full page load, not client-side navigation: the login link is handled
    // by the auth gate as it boots, before any router exists.
    window.location.href = `/enter/${encodeURIComponent(token)}`;
    return true;
  };

  const revealManualEntry = (nextMessage: string | null = null) => {
    setManualEntryOpen(true);
    setMessage(nextMessage);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  const handleClipboardLogin = async () => {
    setMessage(null);
    setIsReadingClipboard(true);

    try {
      if (!navigator.clipboard?.readText) {
        throw new Error('Clipboard API unavailable');
      }
      const clipboardText = await navigator.clipboard.readText();
      if (!clipboardText || !enterWith(clipboardText)) {
        revealManualEntry(t('noInvitation.clipboardInvalid', {
          defaultValue: 'В буфере нет ссылки для входа. Вставьте её вручную.',
        }));
      }
    } catch {
      revealManualEntry(t('noInvitation.clipboardUnavailable', {
        defaultValue: 'Браузер не дал прочитать буфер. Вставьте ссылку вручную.',
      }));
    } finally {
      setIsReadingClipboard(false);
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!enterWith(link, true)) {
      setMessage(t('noInvitation.invalid', { defaultValue: 'Это не похоже на ссылку для входа.' }));
      return;
    }
  };

  const visibleMessage = message ?? (loginLinkRejected
    ? t('noInvitation.rejected', {
      defaultValue: 'Эта ссылка больше не работает. Скопируйте новую и попробуйте ещё раз.',
    })
    : null);

  return (
    <AuthScreenLayout
      title={t('noInvitation.title', { defaultValue: 'Вход в Claude UI' })}
      description={t('noInvitation.description', {
        defaultValue: 'Скопируйте личную ссылку — остальное сделаем сами.',
      })}
      footerText={t('noInvitation.footer', {
        defaultValue: 'После входа это устройство запомнится.',
      })}
      logo={(
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/80 shadow-lg shadow-primary/25 ring-1 ring-inset ring-white/20">
          <KeyRound className="h-8 w-8 text-primary-foreground" />
        </div>
      )}
    >
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => void handleClipboardLogin()}
          disabled={isReadingClipboard}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {isReadingClipboard ? (
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
          ) : (
            <ClipboardPaste aria-hidden className="h-4 w-4" />
          )}
          {t('noInvitation.pasteAndSignIn', { defaultValue: 'Вставить ссылку и войти' })}
        </button>

        {visibleMessage && !manualEntryOpen && (
          <p role="alert" className="text-center text-xs leading-relaxed text-destructive">
            {visibleMessage}
          </p>
        )}

        {!manualEntryOpen ? (
          <button
            type="button"
            onClick={() => revealManualEntry()}
            className="w-full px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('noInvitation.enterManually', { defaultValue: 'Ввести ссылку вручную' })}
          </button>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3 pt-1">
            <div className="flex items-center gap-3 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
              {t('noInvitation.orManually', { defaultValue: 'или вручную' })}
            </div>
            <input
              ref={inputRef}
              type="text"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={link}
              onChange={(event) => {
                setLink(event.target.value);
                setMessage(null);
              }}
              placeholder={t('noInvitation.placeholder', { defaultValue: 'Вставьте сюда ссылку' })}
              className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
            />
            {visibleMessage && (
              <p role="alert" className="text-xs leading-relaxed text-destructive">
                {visibleMessage}
              </p>
            )}
            <button
              type="submit"
              disabled={!link.trim()}
              className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              {t('noInvitation.submit', { defaultValue: 'Войти' })}
            </button>
          </form>
        )}
      </div>
    </AuthScreenLayout>
  );
}
