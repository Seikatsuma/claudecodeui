/**
 * Не больше 15 вкладок (Егор 25.09.26: «максимальное количество чатов — 15;
 * добавляются новые — самые старые просто убираются, чтобы не было переизбытка»).
 *
 * «Самая старая» — та, которую дольше всех не открывали (`openedAt`), а не
 * крайняя слева: вкладки перетаскивают, и нужную Егор мог поставить первой.
 * Вкладки без отметки (открыты до этой правки) считаются самыми давними, между
 * ними — по порядку слева. Открытый сейчас чат не убирается никогда. Отметка
 * ездит на сервер вместе со списком — телефон и компьютер убирают одну и ту же.
 */
export const MAX_OPEN_TABS = 15;

export const capTabs = <T extends { sessionId: string; openedAt?: number }>(tabs: T[], keepSessionId: string | null): T[] => {
  if (tabs.length <= MAX_OPEN_TABS) return tabs;
  const evicted = new Set(
    tabs
      .map((tab, index) => ({ tab, index }))
      .filter(({ tab }) => tab.sessionId !== keepSessionId)
      .sort((a, b) => (a.tab.openedAt ?? 0) - (b.tab.openedAt ?? 0) || a.index - b.index)
      .slice(0, tabs.length - MAX_OPEN_TABS)
      .map(({ tab }) => tab.sessionId),
  );
  return tabs.filter((tab) => !evicted.has(tab.sessionId));
};
