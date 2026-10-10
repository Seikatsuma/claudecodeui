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

/**
 * Слияние пришедшего с сервера списка вкладок с местным.
 *
 * Раньше пришедший список накатывался целиком, и отсутствие в нём открытого
 * здесь чата читалось как «закрыли на другом устройстве» — страница уводила
 * человека к соседней вкладке. Но список мог устареть на самом сервере
 * (запись с телефона со старым снимком), и тогда увод был ложным.
 *
 * Теперь «закрытие» — только явная метка сервера (`closedIds`, ставится по
 * списку remove в PUT). Отсутствие без метки читается как потеря при записи:
 * местные вкладки, которых нет в пришедшем списке, возвращаются на свои
 * позиции — страница затем отправит объединённый список, и сервер сойдётся.
 *
 * Возвращает объединённый список (уже сверх 15) и `activeDropped` — true,
 * только если открытый сейчас чат был в местном списке и явно закрыт
 * (на такой случай страница уходит к соседней вкладке, как при крестике).
 */
export const reconcileRemoteTabs = <T extends { sessionId: string; openedAt?: number }>(
  previous: T[],
  remote: T[],
  closedIds: ReadonlySet<string>,
  activeId: string | null,
): { tabs: T[]; activeDropped: boolean } => {
  const remoteIds = new Set(remote.map((tab) => tab.sessionId));
  const activeDropped =
    activeId !== null &&
    !remoteIds.has(activeId) &&
    previous.some((tab) => tab.sessionId === activeId) &&
    closedIds.has(activeId);
  const merged = [...remote];
  previous.forEach((tab, index) => {
    if (remoteIds.has(tab.sessionId) || closedIds.has(tab.sessionId)) return;
    merged.splice(Math.min(index, merged.length), 0, tab);
  });
  return { tabs: capTabs(merged, activeDropped ? null : activeId), activeDropped };
};
