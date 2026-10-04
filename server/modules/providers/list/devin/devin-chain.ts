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

import { getDevinDatabasePath } from '@/shared/utils.js';

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
