import { useCallback, useEffect, useState } from 'react';

import { api } from '../utils/api';

export type CodexUsageWindow = {
  kind: string;
  percent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
  expired: boolean;
};

export type CodexAccount = {
  available: boolean;
  email: string | null;
  planType: string | null;
  fetchedAtMs: number | null;
  limits: CodexUsageWindow[];
};

/** Сервер держит ответ две минуты; чаще спрашивать бессмысленно. */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** Событие выбора помощника для нового чата: из меню аккаунтов в поле ввода. */
export const SELECT_PROVIDER_EVENT = 'ccui:select-provider';

/**
 * Выбор в меню аккаунтов (а не синхронизация при открытии чата): поле ввода
 * переносит открытый чат к выбранному помощнику — чат Claude уезжает в новый
 * чат Codex с выжимкой, из чата Codex выбор Claude открывает новый чат.
 */
export const CONTINUE_IN_PROVIDER_EVENT = 'ccui:continue-in-provider';

/** Выбор помощника человеком в меню аккаунтов: запомнить и перенести открытый чат. */
export function switchChatProvider(provider: 'claude' | 'codex'): void {
  selectChatProvider(provider);
  window.dispatchEvent(new CustomEvent(CONTINUE_IN_PROVIDER_EVENT, { detail: provider }));
}

/**
 * Выбрать помощника (claude / codex) для следующего нового чата — так же, как
 * это делает выбор модели на пустом экране: запись в localStorage плюс событие
 * для уже открытого поля ввода.
 */
export function selectChatProvider(provider: 'claude' | 'codex'): void {
  localStorage.setItem('selected-provider', provider);
  window.dispatchEvent(new CustomEvent(SELECT_PROVIDER_EVENT, { detail: provider }));
}

/** Какой помощник выбран сейчас и его смена — для отметки в меню аккаунтов. */
export function useSelectedChatProvider(): string {
  const [provider, setProvider] = useState(() => localStorage.getItem('selected-provider') || 'claude');
  useEffect(() => {
    const onSelect = (event: Event) => setProvider(String((event as CustomEvent).detail || 'claude'));
    const onStorage = () => setProvider(localStorage.getItem('selected-provider') || 'claude');
    window.addEventListener(SELECT_PROVIDER_EVENT, onSelect);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(SELECT_PROVIDER_EVENT, onSelect);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return provider;
}

/**
 * Подписка Codex хозяина (GET /api/user/codex-account): почта, тариф, окна
 * 5 ч и неделя. У гостя и без входа — `available: false`, и тогда ни пункта
 * в меню аккаунтов, ни полос в «Расходе» нет.
 */
export function useCodexAccount(): CodexAccount | null {
  const [account, setAccount] = useState<CodexAccount | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api.user.codexAccount();
      if (response.ok) {
        setAccount((await response.json()) as CodexAccount);
      }
    } catch {
      // Справочные данные: молча пропускаем, как и лимиты Claude.
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  return account;
}
