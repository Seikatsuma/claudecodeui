import multer from 'multer';

import { createAudioArchiveService } from './audio-archive.service.js';
import { createVoiceRouter } from './voice.routes.js';
import { createVoiceService } from './voice.service.js';

// Recognition runs at roughly a fifth of real time on this class of machine
// (measured: a 10-minute recording came back in 2 minutes, end to end through
// nginx and the dictation cascade). Five minutes of budget therefore cut off
// anything past ~25 minutes of speech mid-flight, which the UI could only
// report as a dropped recording. Half an hour covers a couple of hours of
// dictation and still fails eventually rather than hanging forever.
const DEFAULT_VOICE_TIMEOUT_MS = 1_800_000;
const parsedTimeoutMs = Number(process.env.VOICE_TIMEOUT_MS);
const voiceTimeoutMs = Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0
  ? parsedTimeoutMs
  : DEFAULT_VOICE_TIMEOUT_MS;

// Upload ceiling for one recording. Kept in step with client_max_body_size in
// the nginx blocks (deploy/ + /etc/nginx/conf.d/claudecodeui-*): whichever is
// smaller is the real limit, and when nginx is the smaller one it truncates
// the body instead of refusing it, so the app sees a corrupt multipart form
// rather than a size error. 25 MB was about 70 minutes of opus - fine for a
// voice note, short for a dictated session.
const DEFAULT_VOICE_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const parsedMaxUploadBytes = Number(process.env.VOICE_MAX_UPLOAD_BYTES);
const voiceMaxUploadBytes = Number.isFinite(parsedMaxUploadBytes) && parsedMaxUploadBytes > 0
  ? parsedMaxUploadBytes
  : DEFAULT_VOICE_MAX_UPLOAD_BYTES;

const voiceService = createVoiceService({
  defaults: {
    // The server-controlled URL is intentional: frontend-configured custom
    // backends are called directly by the browser and never become SSRF input.
    baseUrl: (process.env.VOICE_API_BASE_URL || '').replace(/\/$/, ''),
    apiKey: process.env.VOICE_API_KEY || '',
    sttModel: process.env.VOICE_STT_MODEL || 'whisper-1',
    ttsModel: process.env.VOICE_TTS_MODEL || 'tts-1',
    ttsVoice: process.env.VOICE_TTS_VOICE || 'alloy',
  },
  timeoutMs: voiceTimeoutMs,
  fetchBackend: async (url, options) => {
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), voiceTimeoutMs);
    try {
      return await fetch(url, {
        redirect: 'manual',
        ...options,
        signal: abortController.signal,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }
  },
});

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: voiceMaxUploadBytes },
});

// Копия каждой продиктованной записи в Telegram-чат. Выключено, пока не
// заданы обе переменные: без токена и чата ничего никуда не отправляется.
const audioArchive = createAudioArchiveService({
  botToken: process.env.AUDIO_ARCHIVE_TG_TOKEN || '',
  chatId: process.env.AUDIO_ARCHIVE_TG_CHAT_ID || '',
  fetchTelegram: fetch,
  log: console,
  now: () => new Date(),
});

/** Voice router assembled for the server entrypoint. */
export const voiceRoutes = createVoiceRouter({
  voiceService,
  audioArchive,
  parseAudioUpload: audioUpload.single('audio'),
});
