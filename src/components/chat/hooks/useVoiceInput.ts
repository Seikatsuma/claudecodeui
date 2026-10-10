import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { transcribeVoice } from '../../../lib/voiceApi';
import {
  flushOutbox,
  isConnectionFailure,
  markRecordingActive,
  newRecordingId,
  removePending,
  saveChunk,
  sealRecording,
  startOutboxFlush,
  uploadingNow,
} from '../../../lib/voiceOutbox';

import { recordingsAreArchived } from './useVoiceAvailable';

// Mobile-safe recording: iOS Safari 18.4+ supports webm/opus; older iOS needs mp4.
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

function pickMime(): string {
  for (const t of MIME_CANDIDATES) {
    try {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* isTypeSupported can throw on some iOS versions */
    }
  }
  return '';
}

export type VoiceInputState = 'idle' | 'recording' | 'transcribing';

/**
 * Hard ceiling on one transcription request. The server itself allows half an
 * hour, and the spinner used to follow it blindly: 21.09.26 the service was
 * restarted mid-request, the phone kept the dead connection frozen in the
 * background, and the mic button span for as long as the owner cared to look
 * at it. Twelve minutes is far above any real dictation (measured: a ten
 * minute recording comes back in about two) and turns "forever" into an
 * answer.
 */
const TRANSCRIBE_TIMEOUT_MS = 12 * 60 * 1000;

/**
 * Said when the transcript could not be brought back. For whoever's recordings
 * the server archives, it is worth saying where the audio went - it is in
 * Telegram before transcription even starts, so nothing is lost. A guest on a
 * shared instance is archived nowhere and must not be told otherwise.
 */
function lostTranscriptMessage(): string {
  return recordingsAreArchived()
    ? 'Расшифровка не дошла. Запись сохранена и отправлена в Telegram.'
    : 'Расшифровка не дошла. Попробуйте записать ещё раз.';
}

/** Кусок звука уходит на диск телефона каждые 3 с: погас экран или убило вкладку - записано всё до этого момента. */
const CHUNK_MS = 3000;

/**
 * iOS глушит микрофон, когда приложение уходит в фон (вкладка, свайп домой,
 * звонок), а MediaRecorder при этом молчит - куски просто не приходят. Снаружи
 * это выглядело как «надиктовал минуту - записалась последняя секунда»
 * (Егор 10.10.26). Если кусков нет дольше этого срока, считаем захват
 * приостановленным: показываем паузу на кнопке и считаем потерянное время.
 * Порог выше CHUNK_MS с запасом на очередь обработчиков.
 */
const MIC_SILENCE_MS = 5000;

const SAVED_OFFLINE_MESSAGE = 'Нет связи. Запись сохранена на телефоне и отправится сама, когда сеть появится.';

/** Одна строка в журнал службы об исходе каждой диктовки ([voice-probe]). */
function reportVoiceProbe(entry: Record<string, string | number | boolean>) {
  void authenticatedFetch('/api/user/voice-probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
    keepalive: true,
  }).catch(() => undefined);
}

type WakeLockSentinelLike = { release: () => Promise<void> };

/** Экран не гаснет, пока идёт запись. iOS в режиме энергосбережения может отказать - тогда страхует запись кусками на диск. */
async function holdScreenAwake(): Promise<WakeLockSentinelLike | null> {
  try {
    const wl = (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<WakeLockSentinelLike> } }).wakeLock;
    return wl ? await wl.request('screen') : null;
  } catch {
    return null;
  }
}

/**
 * Push-to-talk dictation. Records the mic, uploads to /api/voice/transcribe
 * (an OpenAI-compatible speech-to-text backend via the Express proxy), and
 * returns the transcript through onTranscript.
 */
export function useVoiceInput(
  onTranscript: (text: string, send?: boolean) => void,
  onError?: (msg: string) => void,
) {
  const [state, setState] = useState<VoiceInputState>('idle');
  // Захват приостановлен системой (iOS глушит микрофон в фоне): запись «идёт»,
  // а звук не пишется. Кнопка показывает это отдельно от самой записи.
  const [micPaused, setMicPaused] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const cancelledRef = useRef(false);
  const startingRef = useRef(false);
  // Тап «стоп», пока getUserMedia ещё в полёте: рекордера нет — запоминаем и
  // гасим запись сразу после его создания.
  const stopRequestedRef = useRef(false);
  // Whether the in-progress stop should auto-send the transcript (vs just fill the box).
  const sendRef = useRef(false);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const recordingIdRef = useRef<string | null>(null);
  // Диагностика записи: когда началась, когда последний раз приходил кусок
  // звука и сколько всего времени захват простаивал (паузы iOS суммируются).
  const startedAtRef = useRef(0);
  const lastChunkAtRef = useRef(0);
  const chunkCountRef = useRef(0);
  const pausedMsRef = useRef(0);
  const pauseSinceRef = useRef<number | null>(null);
  const silenceWatchRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const releaseScreen = () => {
    const lock = wakeLockRef.current;
    wakeLockRef.current = null;
    void lock?.release().catch(() => {});
  };

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  // Stop the mic if the component unmounts mid-recording.
  useEffect(() => {
    cancelledRef.current = false;
    startOutboxFlush();
    // Wake lock снимается системой, когда вкладка уходит в фон; вернулись во время записи - берём заново.
    const reacquire = () => {
      if (document.visibilityState !== 'visible' || recorderRef.current?.state !== 'recording') return;
      void holdScreenAwake().then((lock) => {
        if (lock) wakeLockRef.current = lock;
      });
    };
    document.addEventListener('visibilitychange', reacquire);
    return () => {
      document.removeEventListener('visibilitychange', reacquire);
      releaseScreen();
      if (silenceWatchRef.current) {
        clearInterval(silenceWatchRef.current);
        silenceWatchRef.current = null;
      }
      cancelledRef.current = true;
      startingRef.current = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      recorderRef.current = null;
    };
  }, []);

  const start = useCallback(async () => {
    if (startingRef.current || (recorderRef.current && recorderRef.current.state !== 'inactive')) return;
    startingRef.current = true;
    stopRequestedRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (cancelledRef.current || stopRequestedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = pickMime();
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = rec;
      chunksRef.current = [];
      sendRef.current = false;
      const recId = newRecordingId();
      recordingIdRef.current = recId;
      markRecordingActive(recId);
      let seq = 0;
      startedAtRef.current = Date.now();
      lastChunkAtRef.current = Date.now();
      chunkCountRef.current = 0;
      pausedMsRef.current = 0;
      pauseSinceRef.current = null;
      setMicPaused(false);

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
          void saveChunk(recId, seq++, e.data);
          chunkCountRef.current += 1;
          // Пауза кончилась: досчитываем её в потерянное время и снимаем флаг.
          if (pauseSinceRef.current !== null) {
            pausedMsRef.current += Date.now() - pauseSinceRef.current;
            pauseSinceRef.current = null;
          }
          lastChunkAtRef.current = Date.now();
          setMicPaused(false);
        }
      };

      // MediaRecorder умер сам (драйвер/система): не ждём сторож — сворачиваемся
      // через обычный onstop, который посчитает исход и снимет состояния.
      rec.onerror = () => {
        try { rec.stop(); } catch { /* уже остановлен */ }
      };

      // iOS глушит микрофон событием 'ended' на треке: рекордер может уйти в
      // 'inactive' без onstop, и куски так и лежат мёртвыми. Дожимаем стоп сами.
      const micTrack = stream.getAudioTracks()[0];
      let stoppedHandled = false;
      const finalize = () => {
        if (stoppedHandled) return;
        if (rec.state !== 'inactive') {
          try { rec.stop(); } catch { /* уже остановлен */ }
          return; // onstop доберёт запись; не придёт - сторож вызовет onStopped при 'inactive'
        }
        void onStopped();
      };
      if (micTrack) {
        micTrack.onended = () => finalize();
        micTrack.onmute = () => {
          // Трек приглушён системой: сторож тишины и так это покажет,
          // а здесь только фиксируем начало паузы без ожидания тика.
          if (pauseSinceRef.current === null) pauseSinceRef.current = lastChunkAtRef.current + CHUNK_MS;
          setMicPaused(true);
        };
        micTrack.onunmute = () => {
          if (pauseSinceRef.current !== null) {
            pausedMsRef.current += Date.now() - pauseSinceRef.current;
            pauseSinceRef.current = null;
          }
          setMicPaused(false);
        };
      }

      async function onStopped() {
        if (stoppedHandled) return;
        stoppedHandled = true;
        stopTracks();
        releaseScreen();
        markRecordingActive(null);
        if (silenceWatchRef.current) {
          clearInterval(silenceWatchRef.current);
          silenceWatchRef.current = null;
        }
        // Запись кончилась в паузе - досчитываем её в потерянное время.
        if (pauseSinceRef.current !== null) {
          pausedMsRef.current += Date.now() - pauseSinceRef.current;
          pauseSinceRef.current = null;
        }
        setMicPaused(false);
        const type = rec.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        const durMs = Date.now() - startedAtRef.current;
        const lostMs = pausedMsRef.current;
        // Запись попадает в очередь на телефоне ДО отправки: пока сервер не принял, она не пропадёт.
        const pendingId = await sealRecording(recId, type, chunksRef.current);
        if (cancelledRef.current) {
          // Экран ушёл с записи (смена чата, закрытие): ждать ответа некому, очередь дошлёт сама.
          if (pendingId) void flushOutbox();
          reportVoiceProbe({ outcome: 'cancelled', durMs, chunks: chunkCountRef.current, bytes: blob.size, lostMs, mime: type });
          return;
        }
        if (blob.size < 800) {
          sendRef.current = false;
          setState('idle');
          // «Короткая» запись после минуты диктовки - это не человек помолчал,
          // а iOS приглушил микрофон (экран погас, приложение свёрнуто): куски
          // просто не приходили. Говорим честно, иначе ошибка сбивает с толку.
          const outcome = durMs > 4000 ? 'empty-mic-paused' : 'too-short';
          reportVoiceProbe({ outcome, durMs, chunks: chunkCountRef.current, bytes: blob.size, lostMs, mime: type });
          onError?.(
            durMs > 4000
              ? 'Записи нет: iPhone остановил микрофон — держите приложение открытым, пока диктуете.'
              : 'Recording too short',
          );
          return;
        }
        if (pendingId) uploadingNow.add(pendingId);
        setState('transcribing');
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), TRANSCRIBE_TIMEOUT_MS);
        let keptInQueue = false;
        try {
          const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
          let res: Response;
          try {
            res = await transcribeVoice(blob, `recording.${ext}`, abort.signal);
          } catch (e) {
            keptInQueue = isConnectionFailure(e);
            throw e;
          }
          if (isConnectionFailure(null, res)) keptInQueue = true;
          // Сервер принял запись (она у него и в Telegram) - из очереди телефона можно убрать.
          else if (pendingId) await removePending(pendingId);
          if (!res.ok) throw new Error(`transcribe ${res.status}`);
          const data = await res.json();
          if (cancelledRef.current) return;
          const text = String(data?.text || '').trim();
          // The send intent is read only now, not at stop: Enter pressed while the
          // transcript is still on its way (requestSend) must count too.
          const shouldSend = sendRef.current;
          sendRef.current = false;
          reportVoiceProbe({ outcome: text ? 'sent' : 'no-speech', durMs, chunks: chunkCountRef.current, bytes: blob.size, lostMs, mime: type });
          if (text) onTranscript(text, shouldSend);
          else onError?.('No speech detected');
          // Часть диктовки iOS проглотил - текст пришёл урезанным. Говорим об
          // этом после вставки текста: он уже в поле, предупреждение объясняет
          // обрыв посередине мысли.
          if (lostMs > MIC_SILENCE_MS) {
            onError?.(`Часть записи пропала (~${Math.round(lostMs / 1000)} с): iPhone глушил микрофон в фоне.`);
          }
        } catch (e) {
          if (!cancelledRef.current) {
            // Причина — в консоль: на экране она ничего не объясняет, а при
            // разборе показывает, оборвалось соединение или ответил сервер.
            console.warn('[voice] transcription did not come back', e);
            if (!keptInQueue && pendingId) await removePending(pendingId);
            reportVoiceProbe({ outcome: keptInQueue ? 'queued' : 'failed', durMs, chunks: chunkCountRef.current, bytes: blob.size, lostMs, mime: type });
            onError?.(keptInQueue && pendingId ? SAVED_OFFLINE_MESSAGE : lostTranscriptMessage());
          }
        } finally {
          if (pendingId) uploadingNow.delete(pendingId);
          sendRef.current = false;
          clearTimeout(timeout);
          if (!cancelledRef.current) setState('idle');
        }
      }

      rec.onstop = () => void onStopped();

      rec.start(CHUNK_MS);
      setState('recording');
      // Сторож тишины: iOS в фоне глушит захват и куски перестают приходить.
      // Страницу при этом могут заморозить целиком - тогда проверка сработает
      // при возврате и покажет паузу задним числом.
      silenceWatchRef.current = setInterval(() => {
        const recState = recorderRef.current?.state;
        // Рекордер мёртв, а onstop так и не пришёл (iOS теряет событие) —
        // собираем и досылаем то, что есть, вместо вечного «идёт запись».
        if (recState === 'inactive') finalize();
        if (recState !== 'recording') return;
        const silentMs = Date.now() - lastChunkAtRef.current;
        if (silentMs > MIC_SILENCE_MS) {
          // Пауза реально началась, когда перестал приходить очередной кусок —
          // отсчитываем от ожидаемого момента, а не от детекта сторожем:
          // иначе в потерю влезали бы грейс-порог и честный межкусковый интервал.
          if (pauseSinceRef.current === null) pauseSinceRef.current = lastChunkAtRef.current + CHUNK_MS;
          setMicPaused(true);
        }
      }, 1000);
      void holdScreenAwake().then((lock) => {
        if (!lock) return;
        if (recorderRef.current?.state === 'recording') wakeLockRef.current = lock;
        else void lock.release().catch(() => {});
      });
    } catch (e) {
      recorderRef.current = null;
      // rec.start() мог бросить уже после markRecordingActive — не оставлять
      // мёртвый recId «активным», adoptOrphans иначе пропустит его куски.
      markRecordingActive(null);
      stopTracks();
      if (cancelledRef.current) return;
      const err = e as { name?: string; message?: string };
      let msg = `Mic error: ${err?.message || e}`;
      if (err?.name === 'NotAllowedError') msg = 'Microphone access denied.';
      else if (err?.name === 'NotFoundError') msg = 'No microphone found.';
      onError?.(msg);
      setState('idle');
    } finally {
      startingRef.current = false;
    }
  }, [onTranscript, onError]);

  // Stop recording. Pass { send: true } to auto-send the transcript once it's ready.
  // Guard on the recorder's own state (not React state) so a double tap, or the mic
  // and Send buttons both firing, can't call stop() on an already-inactive recorder.
  const stop = useCallback((opts?: { send?: boolean }) => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      sendRef.current = opts?.send ?? false;
      rec.stop();
    } else if (startingRef.current) {
      // Рекордера ещё нет (getUserMedia в полёте) — тап не должен теряться.
      sendRef.current = opts?.send ?? false;
      stopRequestedRef.current = true;
    }
  }, []);

  // Enter pressed after the recording was already stopped: send the transcript as
  // soon as it arrives instead of sending the half-empty box right now.
  const requestSend = useCallback(() => {
    sendRef.current = true;
  }, []);

  const toggle = useCallback(() => {
    if (state === 'recording') {
      stop();
    } else if (state === 'idle') {
      // Пока микрофон открывается state ещё 'idle' — тап должен отменять запуск,
      // а не молча упираться в startingRef внутри start().
      if (startingRef.current) stop();
      else void start();
    }
  }, [state, start, stop]);

  return { state, toggle, stop, requestSend, micPaused };
}
