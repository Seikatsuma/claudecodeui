import { useEffect, useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';

import type { ChatMessage, ClaudePermissionSuggestion, PermissionGrantResult, Provider } from '../../types/types';
import type { Project } from '../../../../types/app';
import { useSelectedChatProvider } from '../../../../hooks/useCodexAccount';
import { api } from '../../../../utils/api';
import { isToolGroupItem } from '../../utils/toolGrouping';
import {
  describeWorkStretch,
  lastStepDescription,
  workStretchLiveTail,
  workStretchRows,
  type WorkStretchItem,
} from '../../utils/workStretch';
import { Markdown } from './Markdown';

import MessageComponent from './MessageComponent';
import ToolGroupContainer from './ToolGroupContainer';

type DiffLine = {
  type: string;
  content: string;
  lineNum: number;
};

interface WorkStretchContainerProps {
  stretch: WorkStretchItem;
  prevMessage: ChatMessage | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  getMessageKey: (message: ChatMessage) => string;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission?: (suggestion: ClaudePermissionSuggestion) => PermissionGrantResult | null | undefined;
  showRawParameters?: boolean;
  selectedProject?: Project | null;
  provider: Provider | string;
  /**
   * Это свёртка идущей сейчас работы: под строкой виден живой хвост —
   * последние этапы мысли и шаги, в том числе помощников. Работа закончилась —
   * хвост исчезает, остаётся свёрнутая строка.
   */
  isLive?: boolean;
}

type ThoughtDigest = { keep: boolean; ru: string | null };
type DigestState = 'idle' | 'loading' | 'done' | 'failed';

/** Итоги разбора на время жизни вкладки: повторное раскрытие не ходит на сервер. */
const digestByText = new Map<string, ThoughtDigest>();
/**
 * Мысли, разбор которых уже запрошен. Пока чат работает, лента пересобирается
 * на каждое событие; без этого каждый пересбор отменял и заново слал тот же
 * запрос на перевод.
 */
const inflightByText = new Map<string, Promise<void>>();
/** Столько мыслей уходит на сервер за один запрос (там же и потолок). */
const DIGEST_PAGE_SIZE = 60;
/** Столько последних мыслей разбирается для живого хвоста. */
const LIVE_THOUGHTS = 3;

async function requestDigestPage(page: string[]): Promise<void> {
  try {
    const response = await api.user.thoughtDigest(page);
    const data = response.ok ? ((await response.json()) as { items?: Array<ThoughtDigest | null> }) : null;
    const items = data?.items ?? [];
    page.forEach((text, index) => {
      const item = items[index];
      if (item && typeof item.keep === 'boolean') {
        digestByText.set(text, { keep: item.keep, ru: typeof item.ru === 'string' ? item.ru : null });
      }
    });
  } catch {
    // Не вышло — мысли покажутся как есть (см. `state === 'failed'`).
  }
}

/**
 * Какие мысли — важные этапы, и их русский текст.
 *
 * Модель размышляет по-английски — так она сильнее. Показ отбирает этапы
 * (закончено исследование, запущена критика, вывод, решение) и переводит их;
 * рабочие мелочи не показывает. Потолка по числу нет: долгая работа — много
 * этапов (Егор 14.09.26). Разбор запрашивается при раскрытии и для последних
 * мыслей живого хвоста. Не вышло — видны все мысли как есть с пометкой:
 * ничего не пропадает.
 */
function useThoughtDigest(thoughts: ChatMessage[], enabled: boolean) {
  // Codex commentary is already concise, user-facing progress narration. It
  // must appear immediately and verbatim; only raw reasoning needs the digest.
  const digestThoughts = thoughts.filter((message) => !message.isCommentary);
  const texts = digestThoughts.map((message) => String(message.content ?? ''));
  // Ключ по тексту, а не по массиву: массив новый на каждый пересбор ленты.
  const textsKey = texts.join('\u0000');
  const [state, setState] = useState<DigestState>('idle');
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const need = [...new Set(textsKey ? textsKey.split('\u0000') : [])].filter((text) => !digestByText.has(text));
    if (need.length === 0) {
      setState('done');
      return;
    }
    let cancelled = false;
    setState('loading');
    const fresh = need.filter((text) => !inflightByText.has(text));
    for (let start = 0; start < fresh.length; start += DIGEST_PAGE_SIZE) {
      const page = fresh.slice(start, start + DIGEST_PAGE_SIZE);
      const request = requestDigestPage(page).finally(() => {
        page.forEach((text) => inflightByText.delete(text));
      });
      page.forEach((text) => inflightByText.set(text, request));
    }
    const waits = [...new Set(need.map((text) => inflightByText.get(text)).filter(Boolean))] as Promise<void>[];
    // Долгая работа разбирается страницами — этапы появляются по мере готовности.
    waits.forEach((wait) => {
      void wait.then(() => {
        if (!cancelled) setVersion((value) => value + 1);
      });
    });
    void Promise.all(waits).then(() => {
      if (!cancelled) setState(need.every((text) => digestByText.has(text)) ? 'done' : 'failed');
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, textsKey]);

  const known = digestThoughts.every((message) => digestByText.has(String(message.content ?? '')));
  const shown = new Set<ChatMessage>(thoughts.filter((message) => message.isCommentary));
  for (const message of digestThoughts) {
    const digest = digestByText.get(String(message.content ?? ''));
    if (digest ? digest.keep : state === 'failed') shown.add(message);
  }

  return {
    state,
    shown,
    stageCount: known ? shown.size : undefined,
    textFor: (message: ChatMessage): string => {
      if (message.isCommentary) return String(message.content ?? '');
      const digest = digestByText.get(String(message.content ?? ''));
      return digest?.keep && digest.ru ? digest.ru : String(message.content ?? '');
    },
    /** Русский текст мысли, только если она — важный этап и уже разобрана. */
    stageText: (message: ChatMessage): string | null => {
      if (message.isCommentary) return String(message.content ?? '') || null;
      const digest = digestByText.get(String(message.content ?? ''));
      return digest?.keep && digest.ru ? digest.ru : null;
    },
  };
}

/**
 * Свёрнутая строка «Ход работы · 5 этапов · 9 действий» между сообщением
 * человека и ответом ИИ — как работа в Claude Code для VS Code и в приложении
 * Claude.
 *
 * По нажатию раскрываются в порядке событий важные этапы размышлений — все, по
 * -русски — и сделанные шаги одной строкой на действие, с их описанием. Ответ
 * модели стоит ниже целиком: это и есть отчёт.
 */
export default function WorkStretchContainer({
  stretch,
  prevMessage,
  createDiff,
  getMessageKey,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  selectedProject,
  provider,
  isLive = false,
}: WorkStretchContainerProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  // В режиме «Devin» перевод мыслей не запрашивается: он идёт через Claude (Haiku),
  // а там должны тратиться только токены Devin (Егор 03.10.26).
  const claudeFree = provider === 'devin' || useSelectedChatProvider() === 'devin';
  const digest = useThoughtDigest(stretch.thoughts, isExpanded && !claudeFree);
  const showLiveTail = isLive && !isExpanded;
  const liveThoughts = useMemo(() => stretch.thoughts.slice(-LIVE_THOUGHTS), [stretch.thoughts]);
  const liveDigest = useThoughtDigest(liveThoughts, showLiveTail && !claudeFree);
  const liveTail = showLiveTail ? workStretchLiveTail(stretch, liveDigest.stageText) : [];
  const label = describeWorkStretch({
    actionCount: stretch.actionCount,
    errorCount: stretch.errorCount,
    stageCount: digest.stageCount,
    hasThoughts: stretch.thoughts.length > 0,
  });

  const rows = isExpanded ? workStretchRows(stretch, digest.shown) : [];
  const hasThoughts = stretch.thoughts.length > 0;
  const currentStep = lastStepDescription(stretch.messages);

  return (
    <div className="chat-message tool px-3 sm:px-0" data-message-timestamp={stretch.timestamp || undefined}>
      <button
        type="button"
        className="group flex w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
        onClick={() => setIsExpanded((current) => !current)}
        aria-expanded={isExpanded}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          aria-hidden
        />
        <span className="flex-shrink-0">{label}</span>
        {/* Текущий шаг прямо в свёрнутой строке — видно этап, не раскрывая. */}
        {!isExpanded && currentStep && liveTail.length === 0 && (
          <span className="min-w-0 flex-1 truncate text-foreground/70">— {currentStep}</span>
        )}
      </button>

      {liveTail.length > 0 && (
        <div className="ml-2 mt-0.5 space-y-1 border-l border-border/60 pl-3" data-live-tail>
          {liveTail.map((line, index) => {
            const isNewest = index === liveTail.length - 1;
            // Имя помощника — один раз на подряд идущие его шаги, дальше отступ:
            // на телефоне повтор «Помощник «…»:» в каждой строке съедал место.
            const previous = index > 0 ? liveTail[index - 1] : null;
            const sameHelperAsAbove = Boolean(
              line.helper && previous && (previous.helper === line.helper || (previous.isAgentCall && previous.text === line.helper)),
            );
            return (
              <div
                key={line.key}
                className={`flex min-w-0 items-start gap-1.5 text-[12px] leading-[1.45] ${
                  line.kind === 'stage' ? 'text-foreground/80' : 'text-muted-foreground'
                } ${line.helper ? 'pl-3' : ''}`}
              >
                <span
                  className={`mt-[5px] h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                    line.isError
                      ? 'bg-red-500/80'
                      : line.running && isNewest
                        ? 'animate-pulse bg-blue-500'
                        : line.kind === 'stage'
                          ? 'bg-amber-500/70'
                          : 'bg-muted-foreground/40'
                  }`}
                  aria-hidden
                />
                <span className={`min-w-0 flex-1 ${line.kind === 'stage' ? 'line-clamp-3' : 'line-clamp-2'}`}>
                  {line.helper && !sameHelperAsAbove && (
                    <span className="text-muted-foreground/70">Помощник «{line.helper}»: </span>
                  )}
                  {line.isAgentCall && <span className="text-muted-foreground/70">Помощник: </span>}
                  {line.text}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {isExpanded && (
        <div className="ml-2 mt-1 space-y-2 border-l border-border/60 pl-3">
          {hasThoughts && digest.state === 'loading' && (
            <p className="animate-pulse text-[12px] text-muted-foreground/70">Отбираю важные этапы размышлений…</p>
          )}
          {hasThoughts && digest.state === 'failed' && (
            <p className="text-[11px] text-muted-foreground/60">Отобрать важное не удалось — мысли показаны как есть.</p>
          )}
          {rows.length === 0 && digest.state === 'done' && (
            <p className="text-[12px] text-muted-foreground/70">Важных этапов в размышлениях нет.</p>
          )}
          {rows.map((item, index) => {
            if (isToolGroupItem(item)) {
              return (
                <ToolGroupContainer
                  key={`stretch-tools-${getMessageKey(item.messages[0])}`}
                  group={item}
                  prevMessage={prevMessage}
                  createDiff={createDiff}
                  getMessageKey={getMessageKey}
                  onFileOpen={onFileOpen}
                  onShowSettings={onShowSettings}
                  onGrantToolPermission={onGrantToolPermission}
                  showRawParameters={showRawParameters}
                  showThinking={false}
                  selectedProject={selectedProject}
                  provider={provider}
                />
              );
            }
            if (item.isThinking) {
              return (
                <div
                  key={getMessageKey(item)}
                  className="prose prose-sm max-w-none text-[13px] leading-[1.55] text-muted-foreground dark:prose-invert"
                  data-thought-stage
                >
                  <Markdown>{digest.textFor(item)}</Markdown>
                </div>
              );
            }
            if (item.parentToolUseId) {
              // Реплика помощника — строкой хода работы, не пузырём ответа.
              return (
                <p key={getMessageKey(item)} className="text-[12px] leading-[1.45] text-muted-foreground" data-helper-note>
                  <span className="text-muted-foreground/70">Помощник: </span>
                  {String(item.content ?? '')}
                </p>
              );
            }
            return (
              <MessageComponent
                key={getMessageKey(item)}
                message={item}
                prevMessage={index > 0 ? null : prevMessage}
                createDiff={createDiff}
                onFileOpen={onFileOpen}
                onShowSettings={onShowSettings}
                onGrantToolPermission={onGrantToolPermission}
                showRawParameters={showRawParameters}
                showThinking={false}
                selectedProject={selectedProject}
                provider={provider}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
