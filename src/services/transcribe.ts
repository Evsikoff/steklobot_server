import WebSocket from 'ws';
import { config } from '../config.js';
import { ExternalError, sleep, tracked } from './external.js';
import { AudioDecodeError, oggOpusToPcm16, PCM_SAMPLE_RATE } from './audio.js';

/**
 * Распознавание речи через Gemini 3.5 Transcribe Live (Live API, WebSocket).
 *
 * Протокол (BidiGenerateContent):
 *   → { setup: { model, generationConfig, inputAudioTranscription } }
 *   ← { setupComplete: {} }
 *   → { realtimeInput: { audio: { data: base64, mimeType: 'audio/pcm;rate=16000' } } } × N
 *   → { realtimeInput: { audioStreamEnd: true } }
 *   ← { serverContent: { interimInputTranscription | inputTranscription | turnComplete } }
 *
 * Голосовое уже записано целиком, поэтому промежуточные гипотезы
 * (interimInputTranscription) игнорируем и собираем только финальные куски.
 */

/** 100 мс звука = 1600 отсчётов × 2 байта — рекомендованный размер куска */
const CHUNK_BYTES = (PCM_SAMPLE_RATE / 1000) * 100 * 2;
/** при нулевой паузе весь файл улетает мгновенно — не даём буферу сокета распухнуть */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export interface TranscribeCtx {
  threadId?: string | null;
  runId?: string | null;
}

export interface TranscribeResult {
  text: string;
  model: string;
  durationSec: number;
  usage: Record<string, unknown> | null;
}

export function transcribeModel(): string {
  return config.transcribe.model.replace(/^models\//, '');
}

/** Готовность распознавания: тот же ключ, что и у Gemini */
export function transcribeReadiness(): { ok: boolean; reason: string | null } {
  if (!config.transcribe.enabled) return { ok: false, reason: 'распознавание отключено (TRANSCRIBE_ENABLED=0)' };
  if (!config.llm.apiKey) return { ok: false, reason: 'не задан GEMINI_API_KEY' };
  return { ok: true, reason: null };
}

/**
 * Куски финальной расшифровки приходят по мере пауз в речи. Google иногда
 * присылает их уже с ведущим пробелом, иногда — целыми фразами, поэтому
 * пробел добавляем только там, где его действительно нет.
 */
function appendText(acc: string, piece: string): string {
  if (!piece) return acc;
  if (!acc) return piece.trimStart();
  if (/\s$/.test(acc) || /^\s/.test(piece)) return acc + piece;
  return `${acc} ${piece}`;
}

interface ServerMessage {
  setupComplete?: unknown;
  serverContent?: {
    inputTranscription?: { text?: string };
    interimInputTranscription?: { text?: string };
    modelTurn?: { parts?: { text?: string }[] };
    turnComplete?: boolean;
    generationComplete?: boolean;
  };
  usageMetadata?: Record<string, unknown>;
  goAway?: unknown;
  error?: { message?: string };
}

function liveSession(pcm: Buffer, model: string): Promise<{ text: string; usage: Record<string, unknown> | null }> {
  const operation = `transcribeLive:${model}`;
  const url =
    `${config.transcribe.wsBase}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent` +
    `?key=${encodeURIComponent(config.llm.apiKey)}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: 15_000 });

    let transcript = '';
    /** запасной канал: если модель отдаст текст обычным ответом, а не расшифровкой */
    let modelTurnText = '';
    let usage: Record<string, unknown> | null = null;
    let streamEnded = false;
    let settled = false;
    let idleTimer: NodeJS.Timeout | null = null;

    const hardTimer = setTimeout(() => {
      fail(new ExternalError('gemini', operation, `Таймаут ${config.transcribe.timeoutMs} мс`, null, { transcript }));
    }, config.transcribe.timeoutMs);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
      try {
        ws.close(1000);
      } catch {
        /* сокет мог уже закрыться сам */
      }
      resolve({ text: (transcript || modelTurnText).trim(), usage });
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
      try {
        ws.terminate();
      } catch {
        /* сокет мог уже закрыться сам */
      }
      reject(err);
    };

    /**
     * Конец расшифровки определяем по тишине в сокете, а не по turnComplete.
     * Причина: аудио уходит быстрее реального времени, поэтому turnComplete
     * от паузы в середине записи вполне может прийти уже ПОСЛЕ audioStreamEnd —
     * завершаться по нему значит терять хвост фразы. turnComplete лишь
     * укорачивает ожидание до graceMs, и любое следующее сообщение его отменяет.
     */
    const armIdle = (ms = config.transcribe.finalizeMs) => {
      if (!streamEnded || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(finish, ms);
    };

    const streamAudio = async () => {
      for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
        if (settled || ws.readyState !== WebSocket.OPEN) return;
        while (ws.bufferedAmount > MAX_BUFFERED_BYTES && !settled) await sleep(20);
        if (settled || ws.readyState !== WebSocket.OPEN) return;
        const chunk = pcm.subarray(offset, Math.min(offset + CHUNK_BYTES, pcm.length));
        ws.send(
          JSON.stringify({
            realtimeInput: {
              audio: { data: chunk.toString('base64'), mimeType: `audio/pcm;rate=${PCM_SAMPLE_RATE}` },
            },
          }),
        );
        if (config.transcribe.chunkDelayMs > 0) await sleep(config.transcribe.chunkDelayMs);
      }
      if (settled || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      streamEnded = true;
      armIdle();
    };

    ws.on('open', () => {
      const setup: Record<string, unknown> = {
        model: `models/${model}`,
        generationConfig: { responseModalities: ['TEXT'] },
        inputAudioTranscription: config.transcribe.languageCodes.length
          ? { languageCodes: config.transcribe.languageCodes }
          : {},
      };
      ws.send(JSON.stringify({ setup }));
    });

    ws.on('message', (raw) => {
      if (settled) return;
      let message: ServerMessage;
      try {
        message = JSON.parse(raw.toString()) as ServerMessage;
      } catch {
        return; // непарсящийся кадр не повод рушить сессию
      }

      if (message.error?.message) {
        fail(new ExternalError('gemini', operation, `Live API: ${message.error.message}`, null, message));
        return;
      }

      if (message.setupComplete !== undefined) {
        void streamAudio().catch((err) => fail(err));
        return;
      }

      if (message.usageMetadata) usage = message.usageMetadata;

      const content = message.serverContent;
      if (content) {
        const finalText = content.inputTranscription?.text;
        if (finalText) transcript = appendText(transcript, finalText);
        for (const part of content.modelTurn?.parts ?? []) {
          if (part.text) modelTurnText = appendText(modelTurnText, part.text);
        }
        if (streamEnded && (content.turnComplete || content.generationComplete)) {
          armIdle(config.transcribe.graceMs);
          return;
        }
      }

      armIdle();
    });

    // сервер предупреждает о разрыве — забираем то, что успели получить
    ws.on('unexpected-response', (_req, res) => {
      fail(new ExternalError('gemini', operation, `Live API отказал в соединении: HTTP ${res.statusCode}`, res.statusCode ?? null));
    });

    ws.on('error', (err) => {
      fail(new ExternalError('gemini', operation, `Ошибка WebSocket: ${err.message}`));
    });

    ws.on('close', (code, reasonBuffer) => {
      if (settled) return;
      const reason = reasonBuffer?.toString().trim();
      if (streamEnded && transcript) {
        finish();
        return;
      }
      fail(
        new ExternalError(
          'gemini',
          operation,
          `Соединение закрыто до конца расшифровки (код ${code}${reason ? `: ${reason}` : ''})`,
          null,
          { transcript },
        ),
      );
    });
  });
}

/**
 * Полный путь: Ogg/Opus из Telegram → PCM → Live API → текст.
 * Все вызовы учитываются в журнале внешних вызовов как service=gemini.
 */
export async function transcribeVoice(audio: Uint8Array, ctx: TranscribeCtx = {}): Promise<TranscribeResult> {
  const ready = transcribeReadiness();
  if (!ready.ok) throw new ExternalError('gemini', 'transcribeLive', `Распознавание недоступно: ${ready.reason}`);

  const model = transcribeModel();
  const decoded = await oggOpusToPcm16(audio).catch((err) => {
    throw err instanceof AudioDecodeError ? new ExternalError('gemini', 'transcribeDecode', err.message) : err;
  });

  if (decoded.durationSec > config.transcribe.maxDurationSec) {
    throw new ExternalError(
      'gemini',
      'transcribeDecode',
      `Запись длиннее ${config.transcribe.maxDurationSec} с — Live-сессия столько не держит`,
    );
  }

  const result = await tracked(
    {
      service: 'gemini',
      operation: `transcribeLive:${model}`,
      threadId: ctx.threadId,
      runId: ctx.runId,
      request: { model, durationSec: Math.round(decoded.durationSec * 10) / 10, pcmBytes: decoded.pcm.length },
    },
    async () => {
      const session = await liveSession(decoded.pcm, model);
      return { value: session, httpStatus: null, response: { preview: session.text.slice(0, 500), usage: session.usage } };
    },
  );

  if (!result.text) {
    throw new ExternalError('gemini', `transcribeLive:${model}`, 'Модель не вернула текст расшифровки');
  }

  return { text: result.text, model, durationSec: decoded.durationSec, usage: result.usage };
}
