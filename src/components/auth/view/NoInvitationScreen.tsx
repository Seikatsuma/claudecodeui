import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import AuthScreenLayout from './AuthScreenLayout';

/** Accepts a full login link, or just the token pasted on its own. */
const LOGIN_LINK_TOKEN_PATTERN = /(?:\/enter\/)?([A-Za-z0-9_-]{8,})\/?\s*$/;

/**
 * Shown at the bare root address when the visitor has no session and no
 * `/invite/<token>` link.
 *
 * It used to be a plain dead end: a sentence telling you to go find your link,
 * with nothing to do on the page. That is exactly where people landed after
 * opening the app from a home-screen icon - the icon starts at "/", and a
 * standalone web app has its own storage, so no session from the browser is
 * visible there. The field below turns the dead end into one step: paste the
 * link, and this browser is signed in and remembers it from then on.
 */
export default function NoInvitationScreen() {
  const { t } = useTranslation('auth');
  const [link, setLink] = useState('');
  const [isInvalid, setIsInvalid] = useState(false);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const match = link.trim().match(LOGIN_LINK_TOKEN_PATTERN);
    if (!match) {
      setIsInvalid(true);
      return;
    }

    // A full page load, not client-side navigation: the login link is handled
    // by the auth gate as it boots, before any router exists.
    window.location.href = `/enter/${encodeURIComponent(match[1])}`;
  };

  return (
    <AuthScreenLayout
      title={t('noInvitation.title', { defaultValue: 'Нужна ссылка для входа' })}
      description={t('noInvitation.description', {
        defaultValue: 'Вставьте ссылку, которую вам прислали, — и вы войдёте.',
      })}
      footerText={t('noInvitation.footer', {
        defaultValue: 'Ссылка многоразовая: ей можно пользоваться на любом количестве устройств.',
      })}
      logo={(
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/80 shadow-lg shadow-primary/25 ring-1 ring-inset ring-white/20">
          <KeyRound className="h-8 w-8 text-primary-foreground" />
        </div>
      )}
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={link}
          onChange={(event) => {
            setLink(event.target.value);
            setIsInvalid(false);
          }}
          placeholder={t('noInvitation.placeholder', { defaultValue: 'Вставьте сюда ссылку' })}
          className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
        />
        {isInvalid && (
          <p className="text-xs text-destructive">
            {t('noInvitation.invalid', { defaultValue: 'Это не похоже на ссылку для входа.' })}
          </p>
        )}
        <button
          type="submit"
          disabled={!link.trim()}
          className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {t('noInvitation.submit', { defaultValue: 'Войти' })}
        </button>
      </form>
    </AuthScreenLayout>
  );
}
