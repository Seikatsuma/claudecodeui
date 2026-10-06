import { useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { readVoiceConfig, VOICE_CONFIG_SYNC_EVENT } from '../../../hooks/useVoiceConfig';

// Voice UI is gated on the `voiceEnabled` UI preference (toggled in Quick Settings /
// the Settings modal) and a configured voice backend.
const STORAGE_KEY = 'uiPreferences';
const SYNC_EVENT = 'ui-preferences:sync';
let healthRequest: Promise<boolean> | null = null;
// Хук стоит в поле ввода и в кнопке озвучки у КАЖДОГО сообщения. Раньше повтор
// отсекался только пока запрос в полёте, и открытие чата слало проверку голоса
// снова и снова. Готовый ответ держим минуту: настройка голоса на сервере
// меняется раз в жизни, а неудачу не запоминаем, чтобы кнопка ожила сама.
const HEALTH_CACHE_MS = 60_000;
let healthResult: { value: boolean; archived: boolean; at: number } | null = null;

// Повтор после неудачи — один на всех экземпляров хука (кнопка стоит в поле
// ввода и у каждого сообщения): иначе открытый длинный чат слал бы по запросу
// с каждой кнопки. 06.10.26: на мёртвом мобильном интернете (дни «белых
// списков») единственная проверка висла без таймаута или падала, и кнопка
// микрофона пропадала до перезагрузки страницы — повтора не было ни у кого.
const HEALTH_RETRY_MS = 30_000;
const HEALTH_CHANGED_EVENT = 'voice-health:changed';
let healthRetryTimer: ReturnType<typeof setTimeout> | null = null;
let mountedConsumers = 0;

function scheduleHealthRetry() {
  if (healthRetryTimer || mountedConsumers === 0) return;
  healthRetryTimer = setTimeout(() => {
    healthRetryTimer = null;
    checkVoiceHealth()
      .catch(() => false)
      .then((value) => {
        // Слушатели читают готовый ответ, второго запроса не будет.
        window.dispatchEvent(new Event(HEALTH_CHANGED_EVENT));
        if (!value) scheduleHealthRetry();
      });
  }, HEALTH_RETRY_MS);
}

/**
 * Whether the server keeps a copy of this user's recordings (owner only on a
 * shared instance). Read from the last health answer, so it costs nothing at
 * the moment it is needed - when dictation failed and the message on screen
 * must either promise the recording is in Telegram or say nothing of the kind.
 */
export function recordingsAreArchived(): boolean {
  return healthResult?.archived === true;
}

function checkVoiceHealth(): Promise<boolean> {
  if (healthResult && Date.now() - healthResult.at < HEALTH_CACHE_MS) {
    return Promise.resolve(healthResult.value);
  }
  if (healthRequest) return healthRequest;
  // gate: та же связка «таймаут + другой вход», что у /api/projects — без неё
  // проверка на замороженном соединении висела бессрочно и кнопка не появлялась.
  const request = authenticatedFetch('/api/voice/health', {}, { gate: true })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Voice health check failed (${response.status})`);
      const data = await response.json();
      const value = data?.configured === true;
      healthResult = { value, archived: data?.archived === true, at: Date.now() };
      return value;
    })
    .finally(() => {
      healthRequest = null;
    });
  healthRequest = request;
  return request;
}

// Matches the `voiceEnabled: true` default in useUiPreferences.ts's DEFAULTS —
// this reads the same localStorage key independently (to avoid a hook
// dependency cycle), so an unset/missing value must fall back the same way,
// not to `false`, or the mic button stays hidden for every user who has
// never opened Settings.
function readVoiceEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return true;
    const parsed = JSON.parse(raw);
    if (parsed?.voiceEnabled === undefined) return true;
    return parsed.voiceEnabled === true || parsed.voiceEnabled === 'true';
  } catch {
    return true;
  }
}

export function useVoiceAvailable(): boolean {
  const [enabled, setEnabled] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : readVoiceEnabled(),
  );
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const update = () => setEnabled(readVoiceEnabled());
    window.addEventListener('storage', update);
    window.addEventListener(SYNC_EVENT, update as EventListener);
    return () => {
      window.removeEventListener('storage', update);
      window.removeEventListener(SYNC_EVENT, update as EventListener);
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      setAvailable(false);
      return;
    }
    mountedConsumers += 1;
    let active = true;
    let requestId = 0;

    const check = async () => {
      if (readVoiceConfig().baseUrl.trim()) {
        setAvailable(true);
        return;
      }
      const id = ++requestId;
      try {
        const result = await checkVoiceHealth();
        if (active && id === requestId) setAvailable(result);
      } catch {
        if (active && id === requestId) setAvailable(false);
        scheduleHealthRetry();
      }
    };

    // Повторный тик пришёл от общего таймера: читаем готовый ответ, новый
    // запрос не нужен.
    const onHealthChanged = () => setAvailable(healthResult?.value === true);

    void check();
    window.addEventListener(VOICE_CONFIG_SYNC_EVENT, check);
    window.addEventListener('online', check);
    window.addEventListener(HEALTH_CHANGED_EVENT, onHealthChanged);
    return () => {
      mountedConsumers -= 1;
      active = false;
      window.removeEventListener(VOICE_CONFIG_SYNC_EVENT, check);
      window.removeEventListener('online', check);
      window.removeEventListener(HEALTH_CHANGED_EVENT, onHealthChanged);
    };
  }, [enabled]);

  return enabled && available;
}
