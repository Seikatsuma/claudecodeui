/**
 * Живая цепочка беседы Devin.
 *
 * У Devin разговор — дерево узлов в общей `~/.local/share/devin/cli/sessions.db`,
 * а живая ветка задана указателем `sessions.main_chain_id`: от него вверх по
 * `parent_node_id` — это и есть текущая беседа. Отрезанные ветки (свой /revert,
 * наш возврат к сообщению) остаются в таблице, но в цепочку не входят.
 *
 * Потребители: `devin-rewind.ts` (возврат к сообщению — перенос указателя) и
 * `devin-transcript.ts` (экспорт беседы для «Продолжить в новом чате»).
 */
import Database from 'better-sqlite3';

import {
  getDevinDatabasePath,
  readJsonRecord,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

export type DevinChainRow = {
  nodeId: number;
  parentId: number | null;
  chatMessage: string;
  /** Момент записи узла, секунды эпохи (как у колонки created_at). */
  createdAt: number | null;
};

type DevinNodeRow = {
  node_id: number;
  parent_node_id: number | null;
  chat_message: string;
  created_at: number | null;
};

/**
 * Цепочка от корня к вершине — в порядке разговора.
 *
 * Тот же обход, что у devin-session-synchronizer: указатель на вершину может
 * висеть в пустоту (ветку отрезали вне сайта), тогда вершиной считаем самый
 * свежий узел беседы. База открывается вызывающим — читать и писать в одной
 * транзакции нужно на одном соединении.
 */
export function liveDevinChain(
  db: InstanceType<typeof Database>,
  providerSessionId: string,
): DevinChainRow[] {
  const rows = db
    .prepare('SELECT node_id, parent_node_id, chat_message, created_at FROM message_nodes WHERE session_id = ?')
    .all(providerSessionId) as DevinNodeRow[];
  const byId = new Map<number, DevinChainRow>();
  for (const row of rows) {
    byId.set(row.node_id, {
      nodeId: row.node_id,
      parentId: row.parent_node_id,
      chatMessage: row.chat_message,
      createdAt: row.created_at,
    });
  }

  const sessionRow = db
    .prepare('SELECT main_chain_id FROM sessions WHERE id = ?')
    .get(providerSessionId) as { main_chain_id: number | null } | undefined;
  if (!sessionRow) return [];

  let tip = sessionRow.main_chain_id != null && byId.has(sessionRow.main_chain_id)
    ? sessionRow.main_chain_id
    : rows.reduce<number | null>((acc, row) => (acc === null || row.node_id > acc ? row.node_id : acc), null);

  const chain: DevinChainRow[] = [];
  const seen = new Set<number>();
  while (tip !== null && byId.has(tip) && !seen.has(tip)) {
    seen.add(tip);
    const node = byId.get(tip)!;
    chain.push(node);
    tip = node.parentId;
  }
  return chain.reverse();
}

/**
 * Полная переписка беседы Devin — не только живая цепочка.
 *
 * `main_chain_id` задаёт текущее ОКНО КОНТЕКСТА, а не весь разговор: Devin
 * пересобирает контекст каждый ход (системные блоки + сводка + хвост), и
 * вытесненные из окна ходы остаются в таблице брошенными ветками. Живая
 * цепочка «absorbing-mass» — 58 узлов из 2816: в ленте кончалась история
 * через три порции («нет загрузки дальше вверх по чату», 05.10.26).
 *
 * Восстановление. Каждая ветка корень→вершина — снимок контекста на свой
 * момент. Сообщение считаем оставшимся в переписке, если оно дожило хотя бы
 * до одного снимка с более поздней репликой человека (завершённый ход всегда
 * входит в контекст следующего хода), либо оно в живой цепочке. Отрезанное
 * возвратом (`/revert`, «Вернуться сюда») ни в один более поздний снимок не
 * попадает и не воскресает. Служебные ветки суммаризатора (prompt
 * «Conversation to summarize:») в переписку не входят — их ответы выглядели
 * бы сообщениями агента.
 *
 * Особый случай — последний ход человека: «более позднего снимка» для него
 * нет, а в новых сессиях его ввод вообще живёт отдельной веткой «протокол →
 * ввод» и в живую цепочку не попадает. Такой ход считаем состоявшимся, если
 * в живой цепочке есть работа агента позже него; иначе (откат и тишина) —
 * отбрасываем.
 *
 * Порядок — по `metadata.created_at` сообщения (время события, при перелинковке
 * узла не меняется; row.created_at переписывается), копии одного `message_id`
 * сходятся в одну запись — самая свежая по row_id.
 */
export function fullDevinConversation(
  db: InstanceType<typeof Database>,
  providerSessionId: string,
): DevinChainRow[] {
  type RawRow = DevinNodeRow & { row_id: number };
  const rows = db
    .prepare('SELECT row_id, node_id, parent_node_id, chat_message, created_at FROM message_nodes WHERE session_id = ?')
    .all(providerSessionId) as RawRow[];
  if (rows.length === 0) return [];

  const byId = new Map<number, RawRow>();
  const isParent = new Set<number>();
  for (const row of rows) {
    byId.set(row.node_id, row);
    if (row.parent_node_id !== null) isParent.add(row.parent_node_id);
  }

  const sessionRow = db
    .prepare('SELECT main_chain_id FROM sessions WHERE id = ?')
    .get(providerSessionId) as { main_chain_id: number | null } | undefined;
  const mainTip = sessionRow?.main_chain_id != null && byId.has(sessionRow.main_chain_id)
    ? sessionRow.main_chain_id
    : rows.reduce<number | null>((acc, row) => (acc === null || row.node_id > acc ? row.node_id : acc), null);

  type Parsed = {
    key: string;
    time: number;
    isUser: boolean;
    isAgentWork: boolean;
    isSummarizeMarker: boolean;
  };
  const parsedByRowId = new Map<number, Parsed>();
  const parse = (row: RawRow): Parsed => {
    const cached = parsedByRowId.get(row.row_id);
    if (cached) return cached;
    const message = readJsonRecord(row.chat_message) ?? {};
    const metadata = readObjectRecord(message.metadata);
    const messageId = readOptionalString(message.message_id);
    const atMeta = metadata?.created_at;
    const parsedAt = typeof atMeta === 'string' ? Date.parse(atMeta)
      : typeof atMeta === 'number' ? normalizeProviderTimestampMs(atMeta)
      : NaN;
    const content = readOptionalString(message.content) ?? '';
    const role = readOptionalString(message.role);
    const parsed: Parsed = {
      key: messageId ?? `node_${row.node_id}`,
      time: Number.isFinite(parsedAt)
        ? parsedAt
        : (typeof row.created_at === 'number' ? row.created_at * 1000 : 0),
      isUser: role === 'user',
      isAgentWork: role === 'assistant' || role === 'tool',
      isSummarizeMarker: role === 'user'
        && /conversation to summarize:/i.test(content),
    };
    parsedByRowId.set(row.row_id, parsed);
    return parsed;
  };

  // Ветки: от каждой вершины (узел без потомков) и от живой вершины — к корню.
  const tips = new Set<number>();
  for (const row of rows) {
    if (!isParent.has(row.node_id)) tips.add(row.node_id);
  }
  if (mainTip !== null) tips.add(mainTip);

  const chains: RawRow[][] = [];
  for (const tip of tips) {
    const chain: RawRow[] = [];
    const seen = new Set<number>();
    let current: number | null = tip;
    while (current !== null && byId.has(current) && !seen.has(current)) {
      seen.add(current);
      const node: RawRow = byId.get(current)!;
      chain.push(node);
      current = node.parent_node_id;
    }
    chain.reverse();
    chains.push(chain);
  }

  const isSummarizeChain = (chain: RawRow[]): boolean =>
    chain.some((row) => parse(row).isSummarizeMarker);

  const mainChain = mainTip !== null
    ? chains.find(
        (chain) => !isSummarizeChain(chain) && chain[chain.length - 1]?.node_id === mainTip,
      ) ?? []
    : [];
  const mainKeys = new Set(mainChain.map((row) => parse(row).key));

  // Последний ход человека во всём лесу. У него не бывает «более позднего
  // контекста», поэтому witness-правило его не пропускает: ход считаем
  // состоявшимся, если в живой цепочке есть работа агента позже него (ей он
  // и породил эту работу). После отката без нового хода такой работы нет —
  // отменённый вопрос не воскресает.
  let lastUserTime = 0;
  for (const chain of chains) {
    if (isSummarizeChain(chain)) continue;
    for (const row of chain) {
      const parsed = parse(row);
      if (parsed.isUser) lastUserTime = Math.max(lastUserTime, parsed.time);
    }
  }
  const lastTurnAnswered = lastUserTime > 0
    && mainChain.some((row) => {
      const parsed = parse(row);
      return parsed.isAgentWork && parsed.time > lastUserTime;
    });

  // Сообщение — часть переписки, если оно в живой цепочке, дожило хотя бы до
  // одного снимка с более поздней репликой человека (witness) либо лежит в
  // ветке отвеченного последнего хода (включая работу агента после вопроса —
  // без неё в ленте был бы ответ без вопроса).
  const accepted = new Map<string, { row: RawRow; time: number }>();
  for (const chain of chains) {
    if (isSummarizeChain(chain)) continue;
    let witness = 0;
    for (const row of chain) {
      const parsed = parse(row);
      if (parsed.isUser) witness = Math.max(witness, parsed.time);
    }
    const blessAll = lastTurnAnswered && witness === lastUserTime;
    for (const row of chain) {
      const parsed = parse(row);
      if (!mainKeys.has(parsed.key) && !blessAll && witness <= parsed.time) {
        continue;
      }
      const existing = accepted.get(parsed.key);
      if (!existing || existing.row.row_id < row.row_id) {
        accepted.set(parsed.key, { row, time: parsed.time });
      }
    }
  }

  return [...accepted.values()]
    .sort((a, b) => (a.time - b.time) || (a.row.row_id - b.row.row_id))
    .map(({ row }) => ({
      nodeId: row.node_id,
      parentId: row.parent_node_id,
      chatMessage: row.chat_message,
      createdAt: row.created_at,
    }));
}

/** metadata.created_at бывает секундами и миллисекундами — к миллисекундам. */
function normalizeProviderTimestampMs(value: number): number {
  return value > 1e12 ? value : value * 1000;
}

/**
 * Потребитель: `handoff.service.ts` (`askDevinOnce`) — разовый вызов
 * `devin -p` ради выжимки всегда создаёт беседу в служебной папке; помечаем
 * все беседы этой папки скрытыми, чтобы мусорные вызовы не всплывали в списке
 * чатов (синхронизатор читает только COALESCE(hidden,0)=0) и в `devin list`.
 */
export function hideDevinSessionsInDirectory(workingDirectory: string): number {
  try {
    const db = new Database(getDevinDatabasePath());
    try {
      const result = db
        .prepare('UPDATE sessions SET hidden = 1 WHERE working_directory = ? AND COALESCE(hidden, 0) = 0')
        .run(workingDirectory);
      return result.changes;
    } finally {
      db.close();
    }
  } catch (error) {
    console.warn('[Devin] не удалось скрыть служебную беседу:', error);
    return 0;
  }
}
