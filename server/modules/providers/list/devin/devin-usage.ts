/**
 * Счётчик токенов Devin-чата по его SQLite (`sessions.db`, таблица
 * message_nodes).
 *
 * Devin пишет каждый ответ модели узлом с `metadata.metrics`
 * (`input_tokens`, `output_tokens`, `cache_read_tokens`,
 * `cache_creation_tokens`, `request_id`) — по ходу хода, а не в конце,
 * поэтому счётчик актуален в любой момент, а не только после ответа.
 * ACP-канал usage не несёт: ни `usage_update`, ни `session/prompt.usage`
 * у Devin нет (04.10.26, смотрел живые sock-журналы).
 *
 * Правила — те же, что у Claude (`provider-token-usage.service.ts`):
 * — Заполненность контекста = input + cache_read + cache_creation
 *   ПОСЛЕДНЕГО ответа основной цепи (main_chain_id → parent-цепочка);
 *   вывод не считается — это вход, который увидела модель. Совпадает с
 *   `metadata.num_tokens_preceding`, которое Devin пишет на части узлов.
 * — Полный расход = сумма всех ответов сессии (включая ветки и помощников —
 *   они тоже стоят токенов). Один ответ записывается двумя узлами с одним
 *   request_id — склейка по request_id с максимумом по каждому полю.
 *
 * Файл дочитывается инкрементально (новые row_id): у самого длинного чата
 * ~25 МБ JSON, перечитывать его на каждый опрос кнопки и живой прогон нельзя.
 */

import spawn from 'cross-spawn';

import { openDevinDatabase } from '@/modules/providers/list/devin/devin-sessions.provider.js';
import { readConfiguredDefaultModel } from '@/modules/providers/list/devin/devin-models.provider.js';
import {
  readJsonRecord,
  readObjectRecord,
  buildDevinChildEnv,
  readOptionalString,
  resolveDevinCliCommand,
} from '@/shared/utils.js';

type DevinUsageParts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
};

type DevinRequestEntry = {
  /** Узлы, в которых лежит этот ответ (обычно пара-дубль). */
  nodeIds: number[];
  parts: DevinUsageParts;
};

type DevinScanState = {
  rowCount: number;
  maxRowId: number;
  requests: Map<string, DevinRequestEntry>;
};

export type DevinTokenUsage = {
  used: number;
  total: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheTokens: number;
  breakdown: { input: number; output: number };
  contextTokens: number;
  contextWindow: number;
  contextPercent: number;
  model: string | null;
  session: {
    inputTokens: number;
    outputTokens: number;
    freshInputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalTokens: number;
    requests: number;
  };
};

type DevinSessionRow = { model: string | null; main_chain_id: number | null };
type DevinLinkRow = { node_id: number; parent_node_id: number | null };
type DevinMessageRow = { row_id: number; node_id: number; chat_message: string };

const scanStates = new Map<string, DevinScanState>();
const SCAN_STATE_LIMIT = 64;

/** Окно SWE-2 — единственное разрешённое на этой площадке; каталог уточняет. */
const DEFAULT_DEVIN_CONTEXT_WINDOW = 262_000;
const WINDOW_CACHE_TTL_MS = 10 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 15_000;

let contextWindowCache: { at: number; windows: Map<string, number> } | null = null;

function readUsageNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * model_uid → max_context_tokens из `devin models list --format json`
 * (кэш 10 минут — это subprocess). Недоступен → пустая карта, и вызывающий
 * берёт окно SWE-2 по умолчанию.
 */
function readDevinContextWindowMap(): Map<string, number> {
  if (contextWindowCache && Date.now() - contextWindowCache.at < WINDOW_CACHE_TTL_MS) {
    return contextWindowCache.windows;
  }

  const windows = new Map<string, number>();
  const result = spawn.sync(resolveDevinCliCommand(), ['models', 'list', '--format', 'json'], {
    encoding: 'utf8',
    timeout: CATALOG_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: buildDevinChildEnv(),
  });
  if (!result.error && result.status === 0 && result.stdout) {
    try {
      const catalog = readJsonRecord(result.stdout);
      const families = Array.isArray(catalog?.families) ? catalog.families : [];
      for (const family of families) {
        const variants = Array.isArray(readObjectRecord(family)?.variants)
          ? (readObjectRecord(family)?.variants as unknown[])
          : [];
        for (const variant of variants) {
          const record = readObjectRecord(variant);
          const modelUid = readOptionalString(record?.model_uid);
          const maxContext = readUsageNumber(record?.max_context_tokens);
          if (modelUid && maxContext > 0) {
            windows.set(modelUid, maxContext);
          }
        }
      }
    } catch {
      // Битый вывод каталога — работаем на окне по умолчанию.
    }
  }

  contextWindowCache = { at: Date.now(), windows };
  return windows;
}

/**
 * Окно контекста модели Devin. Модель не из каталога → окно SWE-2: другие
 * модели на этой площадке всё равно не запускаются (isAllowedDevinModel).
 * Вызывают readDevinTokenUsage и devin-runtime.provider.js (запасной путь,
 * когда база не читается, а `session/prompt.usage` всё же пришло).
 */
export function resolveDevinContextWindow(model: string | null | undefined): number {
  const windows = readDevinContextWindowMap();
  if (model && windows.has(model)) {
    return windows.get(model) as number;
  }
  return DEFAULT_DEVIN_CONTEXT_WINDOW;
}

function emptyParts(): DevinUsageParts {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

function contextOf(parts: DevinUsageParts): number {
  return parts.input + parts.cacheRead + parts.cacheCreation;
}

/**
 * Разбирает строку message_nodes и, если это ответ модели с metrics,
 * склеивает его в `requests` по request_id (максимум по полям — как у
 * ccusage для Claude: дубли ответа несут одинаковый счёт).
 */
function applyDevinNode(state: DevinScanState, row: DevinMessageRow): void {
  const message = readJsonRecord(row.chat_message);
  if (!message || readOptionalString(message.role) !== 'assistant') {
    return;
  }
  const metrics = readObjectRecord(readObjectRecord(message.metadata)?.metrics);
  if (!metrics) {
    return;
  }
  const parts: DevinUsageParts = {
    input: readUsageNumber(metrics.input_tokens),
    output: readUsageNumber(metrics.output_tokens),
    cacheRead: readUsageNumber(metrics.cache_read_tokens),
    cacheCreation: readUsageNumber(metrics.cache_creation_tokens),
  };
  if (contextOf(parts) + parts.output === 0) {
    return;
  }

  const requestId = readOptionalString(metrics.request_id)
    ?? `node:${row.node_id}`;
  const previous = state.requests.get(requestId);
  const nodeIds = previous ? [...previous.nodeIds] : [];
  if (!nodeIds.includes(row.node_id)) {
    nodeIds.push(row.node_id);
  }
  state.requests.set(requestId, {
    nodeIds,
    parts: previous
      ? {
        input: Math.max(previous.parts.input, parts.input),
        output: Math.max(previous.parts.output, parts.output),
        cacheRead: Math.max(previous.parts.cacheRead, parts.cacheRead),
        cacheCreation: Math.max(previous.parts.cacheCreation, parts.cacheCreation),
      }
      : parts,
  });
}

/**
 * Множество node_id живой цепи: от main_chain_id вверх по parent-ссылкам
 * (заброшенные ветки остаются в таблице и в цепь не входят). Только числа,
 * без chat_message — дёшево даже у чата на тысячи узлов.
 */
function devinChainNodeIds(
  db: NonNullable<ReturnType<typeof openDevinDatabase>>,
  providerSessionId: string,
  mainChainId: number | null,
): Set<number> {
  const links = db
    .prepare('SELECT node_id, parent_node_id FROM message_nodes WHERE session_id = ?')
    .all(providerSessionId) as DevinLinkRow[];
  const parentById = new Map<number, number | null>();
  let maxNodeId = -1;
  for (const link of links) {
    parentById.set(link.node_id, link.parent_node_id);
    if (link.node_id > maxNodeId) {
      maxNodeId = link.node_id;
    }
  }

  const chain = new Set<number>();
  let cursor = mainChainId != null && parentById.has(mainChainId) ? mainChainId : maxNodeId;
  while (cursor !== -1 && !chain.has(cursor)) {
    chain.add(cursor);
    cursor = parentById.get(cursor) ?? -1;
  }
  return chain;
}

/**
 * Актуальный снимок расхода Devin-чата. `providerSessionId` — номер беседы у
 * самого Devin (`sessions.id` его базы), `modelHint` — модель, записанная у
 * чата на сайте (у CLI-чатов sessions.model пуст). null — беседы у Devin нет.
 *
 * Используется сервисом token-usage (REST) и devin-runtime (живой `token_budget`
 * во время хода).
 */
export function readDevinTokenUsage(
  providerSessionId: string,
  options: { modelHint?: string | null } = {},
): DevinTokenUsage | null {
  const db = openDevinDatabase();
  if (!db) {
    return null;
  }

  try {
    const sessionRow = db
      .prepare('SELECT model, main_chain_id FROM sessions WHERE id = ?')
      .get(providerSessionId) as DevinSessionRow | undefined;
    if (!sessionRow) {
      return null;
    }

    const counter = db
      .prepare('SELECT COUNT(*) AS c, MAX(row_id) AS m FROM message_nodes WHERE session_id = ?')
      .get(providerSessionId) as { c: number; m: number | null };
    const rowCount = counter.c;
    const maxRowId = counter.m ?? 0;

    let state = scanStates.get(providerSessionId);
    // Откат/перезапись узлов (rewind) — считаем заново.
    if (!state || rowCount < state.rowCount) {
      state = { rowCount: 0, maxRowId: 0, requests: new Map() };
    }
    if (maxRowId > state.maxRowId) {
      const rows = db
        .prepare('SELECT row_id, node_id, chat_message FROM message_nodes WHERE session_id = ? AND row_id > ? ORDER BY row_id')
        .all(providerSessionId, state.maxRowId) as DevinMessageRow[];
      for (const row of rows) {
        applyDevinNode(state, row);
      }
      state.maxRowId = maxRowId;
    }
    state.rowCount = rowCount;
    scanStates.delete(providerSessionId);
    scanStates.set(providerSessionId, state);
    if (scanStates.size > SCAN_STATE_LIMIT) {
      const oldest = scanStates.keys().next().value;
      if (oldest) {
        scanStates.delete(oldest);
      }
    }

    const chain = devinChainNodeIds(db, providerSessionId, sessionRow.main_chain_id);

    // Заполненность — последний ответ ЖИВОЙ цепи; полный расход — все ответы.
    let lastMain: DevinRequestEntry | null = null;
    const totals = emptyParts();
    let requestCount = 0;
    for (const entry of state.requests.values()) {
      const chainHit = entry.nodeIds.some((nodeId) => chain.has(nodeId));
      if (chainHit && (!lastMain || Math.max(...entry.nodeIds) > Math.max(...lastMain.nodeIds))) {
        lastMain = entry;
      }
      totals.input += entry.parts.input;
      totals.output += entry.parts.output;
      totals.cacheRead += entry.parts.cacheRead;
      totals.cacheCreation += entry.parts.cacheCreation;
      requestCount += 1;
    }

    const contextTokens = lastMain ? contextOf(lastMain.parts) : 0;
    const model = readOptionalString(sessionRow.model ?? undefined)
      ?? readOptionalString(options.modelHint ?? undefined)
      ?? readConfiguredDefaultModel();
    const contextWindow = resolveDevinContextWindow(model);
    const sessionInput = totals.input + totals.cacheRead + totals.cacheCreation;

    return {
      used: contextTokens,
      total: contextWindow,
      inputTokens: lastMain ? contextOf(lastMain.parts) : 0,
      outputTokens: lastMain ? lastMain.parts.output : 0,
      cacheReadTokens: lastMain ? lastMain.parts.cacheRead : 0,
      cacheCreationTokens: lastMain ? lastMain.parts.cacheCreation : 0,
      cacheTokens: lastMain ? lastMain.parts.cacheRead + lastMain.parts.cacheCreation : 0,
      breakdown: {
        input: lastMain ? contextOf(lastMain.parts) : 0,
        output: lastMain ? lastMain.parts.output : 0,
      },
      contextTokens,
      contextWindow,
      contextPercent: contextWindow > 0 ? Math.round((contextTokens / contextWindow) * 1000) / 10 : 0,
      model,
      session: {
        inputTokens: sessionInput,
        outputTokens: totals.output,
        freshInputTokens: totals.input,
        cacheReadTokens: totals.cacheRead,
        cacheCreationTokens: totals.cacheCreation,
        totalTokens: sessionInput + totals.output,
        requests: requestCount,
      },
    };
  } finally {
    db.close();
  }
}

/** Сброс кэша сканов — только для тестов. */
export function resetDevinTokenUsageScans(): void {
  scanStates.clear();
  contextWindowCache = null;
}
