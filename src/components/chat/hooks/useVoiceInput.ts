import { useCallback, useEffect, useRef, useState } from 'react';

import { transcribeVoice } from '../../../lib/voiceApi';

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
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const cancelledRef = useRef(false);
  const startingRef = useRef(false);
  // Whether the in-progress stop should auto-send the transcript (vs just fill the box).
  const sendRef = useRef(false);

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  // Stop the mic if the component unmounts mid-recording.
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
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
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (cancelledRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = pickMime();
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = rec;
      chunksRef.current = [];
      sendRef.current = false;

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      rec.onstop = async () => {
        stopTracks();
        if (cancelledRef.current) return;
        const type = rec.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        if (blob.size < 800) {
          sendRef.current = false;
          setState('idle');
          onError?.('Recording too short');
          return;
        }
        setState('transcribing');
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), TRANSCRIBE_TIMEOUT_MS);
        try {
          const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
          const res = await transcribeVoice(blob, `recording.${ext}`, abort.signal);
          if (!res.ok) throw new Error(`transcribe ${res.status}`);
          const data = await res.json();
          if (cancelledRef.current) return;
          const text = String(data?.text || '').trim();
          // The send intent is read only now, not at stop: Enter pressed while the
          // transcript is still on its way (requestSend) must count too.
          const shouldSend = sendRef.current;
          sendRef.current = false;
          if (text) onTranscript(text, shouldSend);
          else onError?.('No speech detected');
        } catch (e) {
          if (!cancelledRef.current) {
            // Причина — в консоль: на экране она ничего не объясняет, а при
            // разборе показывает, оборвалось соединение или ответил сервер.
            console.warn('[voice] transcription did not come back', e);
            onError?.(lostTranscriptMessage());
          }
        } finally {
          sendRef.current = false;
          clearTimeout(timeout);
          if (!cancelledRef.current) setState('idle');
        }
      };

      rec.start();
      setState('recording');
    } catch (e) {
      recorderRef.current = null;
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
    }
  }, []);

  // Enter pressed after the recording was already stopped: send the transcript as
  // soon as it arrives instead of sending the half-empty box right now.
  const requestSend = useCallback(() => {
    sendRef.current = true;
  }, []);

  const toggle = useCallback(() => {
    if (state === 'recording') stop();
    else if (state === 'idle') start();
  }, [state, start, stop]);

  return { state, toggle, stop, requestSend };
}
