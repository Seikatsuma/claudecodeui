/**
 * Держит открытую страницу на актуальной сборке.
 *
 * Установленное на экран «Домой» приложение может неделями показывать старый
 * код: iOS сохраняет страницу между запусками, а служебный кэш переустанавливается
 * только когда его файл изменился побайтово. Замер с телефона владельца показал
 * ровно это — приложение присылало данные сборки, выкаченной часом раньше, уже
 * после трёх перезапусков.
 *
 * Проверка идёт по имени файла сборки: оно содержит отпечаток содержимого, то
 * есть меняется ровно тогда, когда меняется код. Перезагрузка не чаще одного
 * раза за открытие страницы — чтобы расхождение никогда не превратилось в цикл.
 */
const RELOAD_GUARD_KEY = 'app-update-reloaded';

function currentBundleName(): string | null {
  const script = document.querySelector<HTMLScriptElement>('script[src*="/assets/index-"]');
  return script ? (script.getAttribute('src') ?? '').split('/').pop() ?? null : null;
}

function reloadOnce(): void {
  try {
    if (sessionStorage.getItem(RELOAD_GUARD_KEY)) {
      return;
    }
    sessionStorage.setItem(RELOAD_GUARD_KEY, '1');
  } catch {
    // Приватный режим без хранилища: одна лишняя перезагрузка лучше, чем
    // застрять на старой сборке.
  }
  window.location.reload();
}

export async function ensureLatestBuild(): Promise<void> {
  const running = currentBundleName();
  if (!running) {
    return;
  }

  try {
    const response = await fetch('/', { cache: 'no-store' });
    if (!response.ok) {
      return;
    }
    const html = await response.text();
    const match = html.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/);
    if (match && match[1] !== running) {
      reloadOnce();
    }
  } catch {
    // Нет сети — просто работаем на том, что есть.
  }
}

export function watchServiceWorkerUpdates(): void {
  if (!('serviceWorker' in navigator)) {
    return;
  }
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    if (event.data?.type === 'sw:updated') {
      reloadOnce();
    }
  });
}
