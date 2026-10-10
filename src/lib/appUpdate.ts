/**
 * Держит открытую страницу на актуальной сборке, не перезагружая её под
 * человеком.
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
 *
 * КОГДА перезагружать (10.10.26, жалоба «сайт сам перезагружается»). Раньше
 * новая сборка, найденная на ВИДИМОЙ странице, перезагружала её немедленно.
 * На компьютере вкладка живёт днями, а проверка бежала на каждое возвращение
 * в неё — каждая выкатка выбивала человека из чтения посреди работы. Поэтому:
 * — страница СКРЫТА (вкладка в фоне, свёрнутое окно) → перезагружаем сразу:
 *   человек её всё равно не видит, а вернётся уже к свежей сборке;
 * — страница на виду → не дёргаем: помечаем обновление, и плашка «Доступно
 *   обновление» в панели слева предлагает обновить самому;
 * — свежее открытие страницы → перезагружаем сразу, как раньше: на этапе
 *   загрузки терять нечего, а устаревшей остаться нельзя.
 * Страница, которую долго не сворачивают, не застрянет на старой сборке:
 * плашка видна всё время, а любой уход в фон довезёт обновление сам.
 */
/**
 * Какую сборку мы уже пытались подхватить перезагрузкой.
 *
 * Раньше здесь стоял простой флаг «уже перезагружался». Он защищал от цикла,
 * но заодно намертво отключал механизм: приложение с экрана «Домой» живёт
 * неделями в одной сессии, поэтому ПЕРВОЕ обновление доезжало, а все
 * последующие — уже нет. Правки выкатывались и не появлялись у владельца,
 * сколько бы их ни было.
 *
 * Теперь запоминается имя конкретной сборки. Повторная попытка ради той же
 * сборки не делается (цикл невозможен), а новая сборка снимает запрет сама.
 */
const RELOAD_GUARD_KEY = 'app-update-reload-target';
const SW_RELOAD_GUARD_KEY = 'app-update-sw-reloaded';

/**
 * Сборка, ожидающая решения человека на видимой странице. Лежит в
 * sessionStorage, чтобы состояние переживало перемонтирование React-компонентов,
 * и читается хуком useVersionCheck как начальное значение — плашка не пропадает
 * и не «вспыхивает» при перерисовках.
 */
const PENDING_BUNDLE_KEY = 'app-update-pending-bundle';

/** Событие «на сервере есть сборка новее загруженной» — слушает сайдбар. */
export const UPDATE_PENDING_EVENT = 'app:update-pending';

function currentBundleName(): string | null {
  const script = document.querySelector<HTMLScriptElement>('script[src*="/assets/index-"]');
  return script ? (script.getAttribute('src') ?? '').split('/').pop() ?? null : null;
}

function reloadForBundle(latest: string): void {
  try {
    if (sessionStorage.getItem(RELOAD_GUARD_KEY) === latest) {
      return;
    }
    sessionStorage.setItem(RELOAD_GUARD_KEY, latest);
  } catch {
    // Приватный режим без хранилища: одна лишняя перезагрузка лучше, чем
    // застрять на старой сборке.
  }
  window.location.reload();
}

function reloadOnceForServiceWorker(): void {
  try {
    if (sessionStorage.getItem(SW_RELOAD_GUARD_KEY)) {
      return;
    }
    sessionStorage.setItem(SW_RELOAD_GUARD_KEY, '1');
  } catch {
    // см. выше
  }
  window.location.reload();
}

let pendingNotified = false;

function markUpdatePending(bundle: string): void {
  try {
    sessionStorage.setItem(PENDING_BUNDLE_KEY, bundle);
  } catch {
    // Без хранилища обойдёмся событием — плашка покажется до перемонтирования.
  }
  if (pendingNotified) {
    return;
  }
  pendingNotified = true;
  window.dispatchEvent(new CustomEvent(UPDATE_PENDING_EVENT));
}

/** Есть ли уже помеченная сборка — начальное состояние плашки в сайдбаре. */
export function hasPendingUpdate(): boolean {
  try {
    return sessionStorage.getItem(PENDING_BUNDLE_KEY) !== null;
  } catch {
    return false;
  }
}

export async function ensureLatestBuild(deferWhenVisible = false): Promise<void> {
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
    if (!match || match[1] === running) {
      // Загруженная сборка совпала с серверной — ожидание отработало (страница
      // перезагрузилась из фона или по нажатию плашки): флаг снимаем, иначе
      // плашка висела бы и на свежей версии.
      try {
        sessionStorage.removeItem(PENDING_BUNDLE_KEY);
      } catch {
        // Без хранилища снимать нечего.
      }
      return;
    }
    if (document.visibilityState === 'hidden' || !deferWhenVisible) {
      reloadForBundle(match[1]);
    } else {
      markUpdatePending(match[1]);
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
    if (event.data?.type !== 'sw:updated') {
      return;
    }
    if (document.visibilityState === 'hidden') {
      reloadOnceForServiceWorker();
    } else {
      markUpdatePending('service-worker');
    }
  });
}
