/**
 * Keeps a copy of every dictated recording in a Telegram chat.
 *
 * The web composer is the only place these recordings exist: the transcript
 * goes into the message box and the audio itself is dropped the moment the
 * request finishes. This mails a copy to a chat so the original voice survives
 * the transcription - useful precisely when recognition got a word wrong.
 *
 * Three properties this must have, in order of importance:
 *
 * 1. It can never break dictation. Archiving runs after the transcript has
 *    already been sent to the browser, detached from that response, and every
 *    failure is logged and swallowed. Telegram being down, rate-limiting, or
 *    the token being wrong must cost the user nothing.
 * 2. It is off unless configured. No token, no chat - nothing is sent
 *    anywhere.
 * 3. On a multi-tenant instance it archives the OWNER's recordings only.
 *    The destination chat is the host's private group; posting an invited
 *    guest's voice into it would be handing one person's audio to another.
 */

import { getRequestRuntimeContext } from '@/shared/request-context.js';
import { OPEN_REGISTRATION, isPlatformOwnerWebUser } from '@/shared/utils.js';

/**
 * Telegram's Bot API refuses uploads above 50 MB. Checked before spending
 * minutes uploading something that can only be rejected at the end.
 */
const TELEGRAM_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Telegram truncates captions past this; cut it ourselves so it reads cleanly. */
const TELEGRAM_MAX_CAPTION_CHARS = 1024;

export type ArchivedAudio = {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
};

export type AudioArchiveDependencies = {
  botToken: string;
  chatId: string;
  fetchTelegram: typeof fetch;
  log: Pick<Console, 'warn' | 'info'>;
  now: () => Date;
};

function buildCaption(transcript: string | null, now: Date): string {
  const stamp = now.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  const text = (transcript ?? '').trim();
  if (!text) {
    return `🎙 ${stamp}\n(расшифровка пустая)`;
  }

  const header = `🎙 ${stamp}\n`;
  const room = TELEGRAM_MAX_CAPTION_CHARS - header.length - 1;
  return header + (text.length > room ? `${text.slice(0, room - 1)}…` : text);
}

export function createAudioArchiveService(dependencies: AudioArchiveDependencies) {
  const enabled = Boolean(dependencies.botToken && dependencies.chatId);

  /**
   * True when this request's recording may be archived. Non-owners on a
   * shared instance are excluded - see the module docstring.
   */
  function mayArchiveForCurrentRequest(): boolean {
    if (!OPEN_REGISTRATION) {
      return true;
    }
    const userId = getRequestRuntimeContext()?.userId;
    const numericUserId = userId === undefined || userId === null ? NaN : Number(userId);
    return Number.isFinite(numericUserId) && isPlatformOwnerWebUser(numericUserId);
  }

  async function send(audio: ArchivedAudio, transcript: string | null): Promise<void> {
    const form = new FormData();
    form.append('chat_id', dependencies.chatId);
    form.append('caption', buildCaption(transcript, dependencies.now()));
    form.append(
      'document',
      new Blob([new Uint8Array(audio.bytes)], { type: audio.mimeType || 'audio/webm' }),
      audio.fileName || 'recording.webm',
    );

    const response = await dependencies.fetchTelegram(
      `https://api.telegram.org/bot${dependencies.botToken}/sendDocument`,
      { method: 'POST', body: form },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Telegram replied ${response.status}: ${detail.slice(0, 200)}`);
    }
  }

  return {
    isEnabled(): boolean {
      return enabled;
    },

    /**
     * Fire-and-forget: returns immediately and never rejects, so a caller can
     * invoke it without an await and without a catch.
     */
    archive(audio: ArchivedAudio, transcript: string | null): void {
      if (!enabled || !mayArchiveForCurrentRequest()) {
        return;
      }

      if (audio.bytes.byteLength > TELEGRAM_MAX_UPLOAD_BYTES) {
        dependencies.log.warn(
          `[Voice] Recording of ${Math.round(audio.bytes.byteLength / 1024 / 1024)} MB exceeds `
          + "Telegram's 50 MB upload limit - transcript delivered, copy not archived.",
        );
        return;
      }

      void send(audio, transcript).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        dependencies.log.warn(`[Voice] Could not archive recording to Telegram: ${message}`);
      });
    },
  };
}

export type AudioArchiveService = ReturnType<typeof createAudioArchiveService>;
