import { useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import type { LLMProvider } from '../../../types/app';
import type { ServerScope } from '../../sidebar/hooks/useServerScope';

export type SessionMessageMatch = {
  sessionId: string;
  label: string;
  snippet: string;
  provider: LLMProvider;
};

type ProjectResult = {
  projectId: string | null;
  projectName: string;
  sessions: Array<{
    sessionId: string;
    provider: LLMProvider;
    sessionSummary: string;
    matches: Array<{ snippet: string }>;
  }>;
};

const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

export function useSessionMessageSearch(
  projectId: string | undefined,
  query: string,
  enabled: boolean,
  // Список слева просит ещё и совпадения по названиям среди ВСЕХ чатов папки:
  // сам он видит только загруженную первую страницу (20 чатов).
  includeTitles = false,
  // Вкладка панели («Проекты» / «2-й сервер»): сервер ищет только её чаты.
  serverScope: ServerScope | null = null,
) {
  const [items, setItems] = useState<SessionMessageMatch[]>([]);
  // Идёт ли поиск: список пишет «Ищу…» только пока сервер не ответил «готово».
  const [searching, setSearching] = useState(false);
  const seqRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!enabled || !projectId || trimmed.length < MIN_QUERY) {
      setItems([]);
      setSearching(false);
      esRef.current?.close();
      esRef.current = null;
      return;
    }

    esRef.current?.close();
    esRef.current = null;
    seqRef.current++;
    // Новый запрос — старые результаты сразу убрать, иначе под «sunschool»
    // висели находки прошлого слова, пока не придёт новый ответ.
    setItems([]);
    setSearching(true);

    const handle = setTimeout(() => {
      const seq = ++seqRef.current;
      // Сервер ищет только в этой папке: раньше каждая раскрытая папка
      // запускала поиск по всем чатам всех папок и выбрасывала чужое.
      const url = api.searchConversationsUrl(trimmed, 50, { projectId, serverScope });
      const es = new EventSource(url);
      esRef.current = es;
      const accumulated: SessionMessageMatch[] = [];

      if (includeTitles) {
        es.addEventListener('title-results', (evt) => {
          if (seq !== seqRef.current) return;
          try {
            const data = JSON.parse((evt as MessageEvent).data) as {
              titleResults: Array<{ sessionId: string; provider: LLMProvider; projectId: string | null; sessionTitle: string }>;
            };
            for (const r of data.titleResults) {
              if (r.projectId !== projectId || accumulated.some((i) => i.sessionId === r.sessionId)) continue;
              accumulated.unshift({ sessionId: r.sessionId, label: r.sessionTitle, snippet: '', provider: r.provider });
            }
            setItems([...accumulated]);
          } catch {
            // ignore malformed
          }
        });
      }

      es.addEventListener('result', (evt) => {
        if (seq !== seqRef.current) {
          es.close();
          return;
        }
        try {
          const data = JSON.parse((evt as MessageEvent).data) as { projectResult: ProjectResult };
          const pr = data.projectResult;
          if (pr.projectId !== projectId) return;
          for (const s of pr.sessions) {
            const existing = accumulated.find((i) => i.sessionId === s.sessionId);
            if (existing) {
              // Чат уже в списке по названию — показать, где слово в переписке.
              if (!existing.snippet && s.matches[0]?.snippet) {
                existing.snippet = s.matches[0].snippet;
              }
              continue;
            }
            accumulated.push({
              sessionId: s.sessionId,
              label: s.sessionSummary || s.sessionId,
              snippet: s.matches[0]?.snippet ?? '',
              provider: s.provider,
            });
          }
          setItems([...accumulated]);
        } catch {
          // ignore malformed
        }
      });

      const finish = () => {
        if (seq !== seqRef.current) return;
        es.close();
        esRef.current = null;
        setSearching(false);
      };
      es.addEventListener('done', finish);
      es.addEventListener('error', finish);
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(handle);
    };
  }, [projectId, query, enabled, includeTitles, serverScope]);

  useEffect(() => {
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  return { items, searching };
}
