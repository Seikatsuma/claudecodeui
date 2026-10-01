import { useEffect, useState } from 'react';
import { CLOUDCLI_WORDMARK_FONT_FAMILY } from '../../../shared/constants';

const loadingDotAnimationDelays = ['0s', '0.15s', '0.3s'];

// Экран проверки входа больше не молчит (02.10.26). Егор прислал снимок:
// значок, «Claude UI», три точки — и так минутами. Проверка входа ждёт ответа
// сервера без предела, а домашний провайдер Егора «замораживает» соединение
// с сервером в США (замер: 10 из 10 соединений застряли на 14,3 КБ, через
// VPN — без потерь). Теперь через 5 с видно, что ждём и сколько, через 15 с —
// что делать и кнопка повтора.
const SHOW_WAIT_AFTER_SEC = 5;
const SHOW_HELP_AFTER_SEC = 15;

export default function AuthLoadingScreen() {
  const [startedAt] = useState(() => Date.now());
  const [secondsWaiting, setSecondsWaiting] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setSecondsWaiting(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  const showWait = secondsWaiting >= SHOW_WAIT_AFTER_SEC;
  const showHelp = secondsWaiting >= SHOW_HELP_AFTER_SEC;

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 left-1/2 h-[36rem] w-[36rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
      </div>

      <div className="relative max-w-sm text-center" role="status" aria-live="polite">
        <div className="mb-5 flex justify-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/80 shadow-lg shadow-primary/25 ring-1 ring-inset ring-white/20">
            <img src="/logo.svg" alt="" className="h-9 w-9" />
          </div>
        </div>

        <h1
          className="mb-4 text-2xl font-bold tracking-tight text-foreground"
          style={{ fontFamily: CLOUDCLI_WORDMARK_FONT_FAMILY }}
        >
          Claude UI
        </h1>
        <div aria-hidden className="flex items-center justify-center gap-2">
          {loadingDotAnimationDelays.map((delay) => (
            <div
              key={delay}
              className="h-2 w-2 animate-bounce rounded-full bg-primary"
              style={{ animationDelay: delay }}
            />
          ))}
        </div>

        {showWait ? (
          <p className="mt-6 text-base text-foreground">
            Нет ответа от сервера — {secondsWaiting} с
          </p>
        ) : (
          <p className="sr-only">Проверяю вход…</p>
        )}

        {showHelp && (
          <div className="mt-3 space-y-4">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Связь с сервером застряла по дороге — так бывает, когда интернет-провайдер режет
              доступ к зарубежным серверам. Включите VPN в режиме «весь трафик через VPN»
              и нажмите «Повторить».
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="w-full rounded-xl bg-primary px-5 py-3 text-base font-medium text-primary-foreground"
            >
              Повторить
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
