import { config } from '../config.js';
import { ExternalError, httpJson, sleep, tracked } from './external.js';

/**
 * Telegram уже присылает готовый файл Ogg/Opus. Для записанного голосового
 * Live API не нужен: короткий файл передаётся inline той же мультимодальной
 * модели, которая распознаёт фото. Для больших файлов остаётся Files API.
 * Так голос не зависит от доступности отдельной модели Transcribe.
 */

export interface TranscribeCtx {
  threadId?: string | null;
  runId?: string | null;
  /** Telegram сообщает длительность до скачивания файла */
  durationSec?: number;
  mimeType?: string;
}

export interface TranscribeResult {
  text: string;
  model: string;
  durationSec: number;
  usage: Record<string, unknown> | null;
}

interface GeminiFile {
  name: string;
  uri: string;
  mimeType?: string;
  state?: 'STATE_UNSPECIFIED' | 'PROCESSING' | 'ACTIVE' | 'FAILED';
  error?: { message?: string };
}

interface GenerateContentBody {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: Record<string, unknown>;
}

const apiBase = () => config.llm.apiBase.replace(/\/+$/, '');

export function transcribeModel(): string {
  const configured = config.transcribe.model.replace(/^models\//, '');
  // Старые значения могли остаться в Secret group. На этих моделях голос уже
  // не заработал, поэтому прозрачно используем проверенную GEMINI_MODEL.
  if (configured === 'gemini-3.5-transcribe-live' || configured === 'gemini-3.5-transcribe') {
    return config.llm.model.replace(/^models\//, '');
  }
  return configured;
}

/** Готовность распознавания: тот же ключ, что и у Gemini */
export function transcribeReadiness(): { ok: boolean; reason: string | null } {
  if (!config.transcribe.enabled) return { ok: false, reason: 'распознавание отключено (TRANSCRIBE_ENABLED=0)' };
  if (!config.llm.apiKey) return { ok: false, reason: 'не задан GEMINI_API_KEY' };
  return { ok: true, reason: null };
}

function remainingMs(deadline: number, operation: string): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new ExternalError('gemini', operation, `Таймаут ${config.transcribe.timeoutMs} мс`);
  }
  return remaining;
}

function fileFrom(body: unknown, operation: string, httpStatus: number): GeminiFile {
  const file = (body as { file?: Partial<GeminiFile> } | null)?.file;
  if (!file?.name || !file.uri) {
    throw new ExternalError('gemini', operation, 'Files API не вернул имя или URI загруженного аудио', httpStatus, body);
  }
  return file as GeminiFile;
}

async function startUpload(
  bytes: number,
  mimeType: string,
  model: string,
  deadline: number,
  ctx: TranscribeCtx,
): Promise<string> {
  const operation = `transcribeUploadStart:${model}`;
  const response = await httpJson(
    {
      service: 'gemini',
      operation,
      threadId: ctx.threadId,
      runId: ctx.runId,
      request: { model, mimeType, bytes },
    },
    `${apiBase()}/upload/v1beta/files`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': config.llm.apiKey,
        'x-goog-upload-protocol': 'resumable',
        'x-goog-upload-command': 'start',
        'x-goog-upload-header-content-length': String(bytes),
        'x-goog-upload-header-content-type': mimeType,
      },
      body: JSON.stringify({ file: { display_name: `customer-voice-${Date.now()}.ogg` } }),
      timeoutMs: remainingMs(deadline, operation),
    },
    { retries: 1, retryDelayMs: 500 },
  );

  return tracked(
    {
      service: 'gemini',
      operation: `${operation}:parse`,
      threadId: ctx.threadId,
      runId: ctx.runId,
      request: { httpStatus: response.status },
    },
    async () => {
      const uploadUrl = response.headers.get('x-goog-upload-url');
      if (!uploadUrl) {
        throw new ExternalError('gemini', operation, 'Files API не вернул x-goog-upload-url', response.status, response.body);
      }
      return { value: uploadUrl, httpStatus: response.status, response: { uploadUrlReceived: true } };
    },
  );
}

async function uploadAudio(
  audio: Uint8Array,
  mimeType: string,
  model: string,
  uploadUrl: string,
  deadline: number,
  ctx: TranscribeCtx,
): Promise<GeminiFile> {
  const operation = `transcribeUpload:${model}`;
  const response = await httpJson(
    {
      service: 'gemini',
      operation,
      threadId: ctx.threadId,
      runId: ctx.runId,
      request: { model, mimeType, bytes: audio.byteLength },
    },
    uploadUrl,
    {
      method: 'POST',
      headers: {
        'content-length': String(audio.byteLength),
        'content-type': mimeType,
        'x-goog-upload-offset': '0',
        'x-goog-upload-command': 'upload, finalize',
      },
      body: Buffer.from(audio),
      timeoutMs: remainingMs(deadline, operation),
    },
    { retries: 0 },
  );
  return fileFrom(response.body, operation, response.status);
}

async function waitForFile(file: GeminiFile, model: string, deadline: number, ctx: TranscribeCtx): Promise<GeminiFile> {
  let current = file;
  while (current.state === 'PROCESSING') {
    await sleep(Math.min(500, remainingMs(deadline, `transcribeFile:${model}`)));
    const operation = `transcribeFile:${model}`;
    const response = await httpJson(
      {
        service: 'gemini',
        operation,
        threadId: ctx.threadId,
        runId: ctx.runId,
        request: { name: current.name },
      },
      `${apiBase()}/v1beta/${current.name}`,
      {
        method: 'GET',
        headers: { 'x-goog-api-key': config.llm.apiKey },
        timeoutMs: remainingMs(deadline, operation),
      },
      { retries: 1, retryDelayMs: 500 },
    );
    current = response.body as GeminiFile;
  }

  if (current.state === 'FAILED') {
    throw new ExternalError(
      'gemini',
      `transcribeFile:${model}`,
      `Gemini не смог обработать аудиофайл${current.error?.message ? `: ${current.error.message}` : ''}`,
      null,
      current,
    );
  }
  return current;
}

function transcriptionPrompt(): string {
  const languages = config.transcribe.languageCodes.length
    ? `Основные языки записи: ${config.transcribe.languageCodes.join(', ')}. `
    : '';
  return (
    'Точно расшифруй голосовое сообщение клиента. ' +
    languages +
    'Верни только произнесённый текст без кавычек, пояснений, ответа клиенту и описания звуков. ' +
    'Сохрани марки автомобилей, модели, годы, номера вариантов и типы стёкол.'
  );
}

async function parseTranscript(
  response: Awaited<ReturnType<typeof httpJson>>,
  operation: string,
  model: string,
  ctx: TranscribeCtx,
): Promise<{ text: string; usage: Record<string, unknown> | null }> {
  return tracked(
    {
      service: 'gemini',
      operation: `${operation}:parse`,
      threadId: ctx.threadId,
      runId: ctx.runId,
      request: { model },
    },
    async () => {
      const body = response.body as GenerateContentBody;
      if (body.promptFeedback?.blockReason) {
        throw new ExternalError(
          'gemini',
          operation,
          `Аудио заблокировано моделью: ${body.promptFeedback.blockReason}`,
          response.status,
          body,
        );
      }
      const candidate = body.candidates?.[0];
      const text = (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join('').trim();
      if (!text) {
        throw new ExternalError(
          'gemini',
          operation,
          `Модель не вернула текст расшифровки (finishReason=${candidate?.finishReason ?? 'unknown'})`,
          response.status,
          body,
        );
      }
      return {
        value: { text, usage: body.usageMetadata ?? null },
        httpStatus: response.status,
        response: { preview: text.slice(0, 500), usage: body.usageMetadata ?? null },
      };
    },
  );
}

async function generateInlineTranscript(
  audio: Uint8Array,
  mimeType: string,
  model: string,
  deadline: number,
  ctx: TranscribeCtx,
): Promise<{ text: string; usage: Record<string, unknown> | null }> {
  const operation = `transcribeInline:${model}`;
  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: transcriptionPrompt() },
          { inlineData: { mimeType, data: Buffer.from(audio).toString('base64') } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: config.transcribe.maxOutputTokens,
    },
  };
  const response = await httpJson(
    {
      service: 'gemini',
      operation,
      threadId: ctx.threadId,
      runId: ctx.runId,
      request: { model, mimeType, bytes: audio.byteLength },
    },
    `${apiBase()}/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.llm.apiKey },
      body: JSON.stringify(payload),
      timeoutMs: remainingMs(deadline, operation),
    },
    { retries: 1, retryDelayMs: 800 },
  );
  return parseTranscript(response, operation, model, ctx);
}

async function generateFileTranscript(
  file: GeminiFile,
  mimeType: string,
  model: string,
  deadline: number,
  ctx: TranscribeCtx,
): Promise<{ text: string; usage: Record<string, unknown> | null }> {
  const operation = `transcribe:${model}`;
  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: transcriptionPrompt() },
          { fileData: { fileUri: file.uri, mimeType: file.mimeType || mimeType } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: config.transcribe.maxOutputTokens,
    },
  };
  const response = await httpJson(
    {
      service: 'gemini',
      operation,
      threadId: ctx.threadId,
      runId: ctx.runId,
      request: { model, file: file.name, mimeType: file.mimeType || mimeType },
    },
    `${apiBase()}/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.llm.apiKey },
      body: JSON.stringify(payload),
      timeoutMs: remainingMs(deadline, operation),
    },
    { retries: 1, retryDelayMs: 800 },
  );

  return parseTranscript(response, operation, model, ctx);
}

async function deleteFile(name: string, model: string, ctx: TranscribeCtx): Promise<void> {
  await httpJson(
    {
      service: 'gemini',
      operation: `transcribeDelete:${model}`,
      threadId: ctx.threadId,
      runId: ctx.runId,
      request: { name },
    },
    `${apiBase()}/v1beta/${name}`,
    {
      method: 'DELETE',
      headers: { 'x-goog-api-key': config.llm.apiKey },
      timeoutMs: Math.min(config.transcribe.timeoutMs, 5_000),
    },
    { retries: 0 },
  );
}

/** Аудио клиента → inline Gemini (с Files API как резервом) → текст. */
export async function transcribeVoice(audio: Uint8Array, ctx: TranscribeCtx = {}): Promise<TranscribeResult> {
  const ready = transcribeReadiness();
  if (!ready.ok) throw new ExternalError('gemini', 'transcribe', `Распознавание недоступно: ${ready.reason}`);

  const model = transcribeModel();
  const mimeType = ctx.mimeType || 'audio/ogg';
  const deadline = Date.now() + config.transcribe.timeoutMs;
  let file: GeminiFile | null = null;

  try {
    if (audio.byteLength <= config.transcribe.inlineMaxFileBytes) {
      try {
        const result = await generateInlineTranscript(audio, mimeType, model, deadline, ctx);
        return {
          text: result.text,
          model,
          durationSec: ctx.durationSec ?? 0,
          usage: result.usage,
        };
      } catch {
        // Inline — основной быстрый путь. При отказе пробуем тот же файл через Files API;
        // первая причина уже сохранена в журнале external_events.
      }
    }

    const uploadUrl = await startUpload(audio.byteLength, mimeType, model, deadline, ctx);
    file = await uploadAudio(audio, mimeType, model, uploadUrl, deadline, ctx);
    file = await waitForFile(file, model, deadline, ctx);
    const result = await generateFileTranscript(file, mimeType, model, deadline, ctx);
    return {
      text: result.text,
      model,
      durationSec: ctx.durationSec ?? 0,
      usage: result.usage,
    };
  } finally {
    // Удаление не задерживает ответ клиенту; если оно не удалось, ошибка останется в журнале.
    if (file?.name) void deleteFile(file.name, model, ctx).catch(() => undefined);
  }
}
