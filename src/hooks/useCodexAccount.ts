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
 * Выбор в меню аккаунтов (а не синхронизация при открытии чата): открытый чат
 * другого помощника сменяется новым пустым чатом выбранного. Переписка не
 * переносится — каждый помощник держит свой список чатов (useServerScope).
 */
export const CONTINUE_IN_PROVIDER_EVENT = 'ccui:continue-in-provider';

/** Выбор помощника человеком в меню аккаунтов: запомнить и открыть его список. */
export type ChatProviderChoice = 'claude' | 'codex' | 'devin';

export function switchChatProvider(provider: ChatProviderChoice): void {
  selectChatProvider(provider);
  window.dispatchEvent(new CustomEvent(CONTINUE_IN_PROVIDER_EVENT, { detail: provider }));
}

/**
 * Выбрать помощника (claude / codex / devin) для следующего нового чата — так же, как
 * это делает выбор модели на пустом экране: запись в localStorage плюс событие
 * для уже открытого поля ввода.
 */
export function selectChatProvider(provider: ChatProviderChoice): void {
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

export type DevinAccountEntry = {
  slot: 1 | 2;
  available: boolean;
  name: string | null;
};

export type DevinAccount = {
  /** Верхний уровень — АКТИВНЫЙ аккаунт Devin (слот `slot`). */
  available: boolean;
  name: string | null;
  /** Единственное семейство моделей, разрешённое на этом аккаунте. */
  models: string;
  fetchedAtMs: number | null;
  slot: 1 | 2;
  /** Оба слота Devin: у кого есть вход — те попадают в меню. */
  accounts: DevinAccountEntry[];
  /** Второго аккаунта ещё нет — в меню показать «Добавить аккаунт Devin». */
  canAddSecond: boolean;
};

/** Событие «аккаунты Devin изменились» (вошли во второй, переключили): хук перечитает ответ сразу. */
export const DEVIN_ACCOUNT_CHANGED_EVENT = 'ccui:devin-account-changed';

/**
 * Подписка Devin хозяина (GET /api/user/devin-account): имя входа и признак
 * «вошёл». Окон лимитов Devin не публикует, поэтому полос в «Расходе» нет.
 * У гостя и без входа — `available: false`, и тогда пункта в меню аккаунтов нет.
 */
export function useDevinAccount(): DevinAccount | null {
  const [account, setAccount] = useState<DevinAccount | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api.user.devinAccount();
      if (response.ok) {
        setAccount((await response.json()) as DevinAccount);
      }
    } catch {
      // Справочные данные: молча пропускаем.
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_INTERVAL_MS);
    const onChanged = () => void load();
    window.addEventListener(DEVIN_ACCOUNT_CHANGED_EVENT, onChanged);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(DEVIN_ACCOUNT_CHANGED_EVENT, onChanged);
    };
  }, [load]);

  return account;
}
