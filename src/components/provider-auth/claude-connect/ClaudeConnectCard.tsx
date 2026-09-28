import { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, Loader2, X } from 'lucide-react';

import LLMProviderLogo from '../../llm-provider-logo/LLMProviderLogo';
import {
  cancelClaudeConnect,
  dismissClaudeLoginExpired,
  dismissJustConnected,
  sendClaudeConnectCode,
  startClaudeConnect,
  useClaudeConnect,
} from './claudeConnectStore';

/**
 * Карточка «Подключите Claude» — вход в подписку одной кнопкой, без терминала.
 * composer — над полем ввода чата (видна, пока Claude не подключён);
 * settings — в «Настройки → Агенты → Claude».
 */

const PLAN_NAMES: Record<string, string> = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' };

const accountLine = (email: string | null, plan: string | null): string => {
  const planName = plan ? PLAN_NAMES[plan] || plan : null;
  return [email, planName ? `подписка ${planName}` : null].filter(Boolean).join(' · ');
};

type Props = { variant: 'composer' | 'settings' };

export default function ClaudeConnectCard({ variant }: Props) {
  const connect = useClaudeConnect();
  const [code, setCode] = useState('');
  const [showCodeField, setShowCodeField] = useState(false);

  // «Готово» висит 8 секунд и убирается само.
  useEffect(() => {
    if (!connect.justConnected || variant !== 'composer') return undefined;
    const timer = setTimeout(dismissJustConnected, 8000);
    return () => clearTimeout(timer);
  }, [connect.justConnected, variant]);

  useEffect(() => {
    if (connect.phase !== 'waiting') {
      setCode('');
      setShowCodeField(false);
    }
  }, [connect.phase]);

  const waiting = connect.phase === 'waiting';
  const connected = connect.loggedIn === true;

  if (variant === 'composer') {
    const visible = connect.loggedIn === false || waiting || connect.phase === 'error' || connect.forcedOpen || connect.justConnected || connect.authExpired;
    if (!visible || connect.loggedIn === null) return null;
  }

  const shell = variant === 'composer'
    ? 'mx-auto mb-3 max-w-[54.25rem] rounded-2xl border border-[#d97757]/40 bg-card px-4 py-3.5 shadow-sm'
    : 'rounded-xl border border-border/60 bg-muted/30 px-4 py-3.5';

  // Подключено: коротко и спокойно. Вход устарел — ниже, как «не подключён», с «Войти заново».
  if (connected && !waiting && !connect.authExpired) {
    return (
      <div className={shell} role="status">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-500" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">
              {connect.justConnected ? 'Готово — Claude подключён. Можно писать.' : 'Claude подключён'}
            </div>
            {accountLine(connect.email, connect.subscriptionType) && (
              <div className="mt-0.5 truncate text-sm text-muted-foreground">{accountLine(connect.email, connect.subscriptionType)}</div>
            )}
            {connect.authMethod === 'oauth_token' && (
              <div className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                Сейчас Claude работает по ключу подписки. Google Диск, Gmail, Календарь и другие подключения аккаунта Claude заработают, если войти через браузер в свой аккаунт Claude с подпиской Pro или Max — один раз.
              </div>
            )}
            {connect.authMethod === 'oauth_token' ? (
              <button
                type="button"
                onClick={() => void startClaudeConnect()}
                className="mt-3 rounded-lg bg-[#d97757] px-4 py-2 text-sm font-medium text-white hover:bg-[#c96442]"
              >
                Войти через браузер
              </button>
            ) : (variant === 'settings' || connect.forcedOpen) && (
              <button
                type="button"
                onClick={() => void startClaudeConnect()}
                className="mt-2 text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                Войти другим аккаунтом
              </button>
            )}
          </div>
          {variant === 'composer' && (
            <button type="button" onClick={dismissJustConnected} aria-label="Закрыть" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={shell} role="region" aria-label="Подключение Claude">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 h-6 w-6 flex-shrink-0">
          {waiting ? <Loader2 className="h-6 w-6 animate-spin text-[#d97757]" /> : <LLMProviderLogo provider="claude" className="h-6 w-6" />}
        </div>
        <div className="min-w-0 flex-1">
          {waiting ? (
            <>
              <div className="text-[15px] font-semibold text-foreground">Подтвердите вход в браузере</div>
              <div className="mt-1 text-sm leading-relaxed text-muted-foreground">
                Открылась страница Claude: войдите в аккаунт с подпиской и нажмите «Разрешить» (Authorize). Потом вернитесь сюда — остальное программа сделает сама.
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                {connect.url && (
                  <a href={connect.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[#d97757] underline underline-offset-2 hover:opacity-80">
                    Браузер не открылся? Открыть страницу <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                {!showCodeField && (
                  <button type="button" onClick={() => setShowCodeField(true)} className="text-muted-foreground underline underline-offset-2 hover:text-foreground">
                    Страница показала код?
                  </button>
                )}
                <button type="button" onClick={() => void cancelClaudeConnect()} className="text-muted-foreground underline underline-offset-2 hover:text-foreground">
                  Отмена
                </button>
              </div>
              {showCodeField && (
                <form
                  className="mt-3 flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (code.trim()) void sendClaudeConnectCode(code);
                  }}
                >
                  <input
                    autoFocus
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="Вставьте код со страницы"
                    className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-[#d97757]"
                  />
                  <button
                    type="submit"
                    disabled={!code.trim() || connect.codeSent}
                    className="rounded-lg bg-[#d97757] px-4 py-2 text-sm font-medium text-white hover:bg-[#c96442] disabled:opacity-50"
                  >
                    {connect.codeSent ? 'Проверяю…' : 'Готово'}
                  </button>
                </form>
              )}
            </>
          ) : (
            <>
              <div className="text-[15px] font-semibold text-foreground">
                {connect.phase === 'error' ? 'Подключить Claude не получилось' : connect.authExpired ? 'Вход в Claude устарел' : 'Подключите Claude'}
              </div>
              <div className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {connect.phase === 'error' && connect.message
                  ? connect.message
                  : connect.authExpired
                    ? `Claude перестал отвечать: вход${connect.email ? ` (${connect.email})` : ''} больше не действует. Нажмите кнопку — откроется браузер: войдите в свой аккаунт Claude с подпиской и нажмите «Разрешить». Потом отправьте сообщение ещё раз.`
                    : 'Claude думает по вашей подписке Claude Pro или Max. Нажмите кнопку — откроется браузер, войдите и нажмите «Разрешить». Это нужно один раз.'}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <button
                  type="button"
                  onClick={() => void startClaudeConnect()}
                  className="rounded-lg bg-[#d97757] px-4 py-2 text-sm font-medium text-white hover:bg-[#c96442]"
                >
                  {connect.phase === 'error' ? 'Попробовать ещё раз' : connect.authExpired ? 'Войти заново' : 'Подключить Claude'}
                </button>
                {connect.authExpired && connect.phase !== 'error' && (
                  <button type="button" onClick={dismissClaudeLoginExpired} className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground">
                    Уже вошли — скрыть
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
