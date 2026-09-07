import { config } from '../config.js';
import { ExternalError, httpJson, summarizeBody, tracked } from './external.js';

const api = (method: string) => `${config.telegram.apiBase}/bot${config.telegram.botToken}/${method}`;

export function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

interface CallCtx {
  threadId?: string | null;
  runId?: string | null;
}

async function call<T>(
  method: string,
  payload: Record<string, unknown>,
  ctx: CallCtx = {},
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<T> {
  const res = await httpJson(
    { service: 'telegram', operation: method, threadId: ctx.threadId, runId: ctx.runId, request: payload },
    api(method),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: opts.timeoutMs ?? 20_000,
    },
    { retries: opts.retries ?? 2 },
  );
  return (res.body as { result: T }).result;
}

async function callWithFile<T>(
  method: string,
  payload: Record<string, string | number>,
  file: { field: string; bytes: Uint8Array; filename: string; mimeType: string },
  ctx: CallCtx = {},
): Promise<T> {
  const requestSummary = { ...payload, [file.field]: { filename: file.filename, mimeType: file.mimeType, bytes: file.bytes.length } };
  return tracked(
    { service: 'telegram', operation: method, threadId: ctx.threadId, runId: ctx.runId, request: requestSummary },
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const form = new FormData();
        for (const [key, value] of Object.entries(payload)) form.append(key, String(value));
        form.append(file.field, new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }), file.filename);
        const res = await fetch(api(method), { method: 'POST', body: form, signal: controller.signal });
        const text = await res.text();
        let body: { ok?: boolean; result?: T; description?: string } = {};
        try {
          body = text ? (JSON.parse(text) as typeof body) : {};
        } catch {
          // Ошибка ниже сохранит безопасное краткое описание ответа.
        }
        if (!res.ok || !body.ok || body.result == null) {
          throw new ExternalError(
            'telegram',
            method,
            `HTTP ${res.status}: ${body.description || summarizeBody(text) || 'Telegram не принял файл'}`,
            res.status,
            body,
          );
        }
        const messageId = (body.result as unknown as { message_id?: number }).message_id;
        return { value: body.result, httpStatus: res.status, response: { ok: true, message_id: messageId } };
      } catch (err) {
        if (err instanceof ExternalError) throw err;
        if ((err as Error)?.name === 'AbortError') throw new ExternalError('telegram', method, 'Таймаут 30000 мс');
        throw new ExternalError('telegram', method, `Сетевая ошибка: ${(err as Error)?.message ?? String(err)}`);
      } finally {
        clearTimeout(timer);
      }
    },
  );
}

/** Голосовое сообщение: Telegram всегда отдаёт его в Ogg/Opus */
export interface TgVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

/** Одна из версий фотографии; Telegram присылает массив от миниатюры к оригиналу */
export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  date: number;
  text?: string;
  caption?: string;
  voice?: TgVoice;
  photo?: TgPhotoSize[];
  document?: TgDocument;
  chat: { id: number; type: string; title?: string; first_name?: string; last_name?: string; username?: string };
  from?: { id: number; is_bot: boolean; first_name?: string; last_name?: string; username?: string };
  // остальные вложения бот не читает: содержимое не нужно — важен сам факт и тип,
  // файл уходит менеджеру через copyMessage
  audio?: unknown;
  video?: unknown;
  video_note?: unknown;
  animation?: unknown;
  sticker?: unknown;
  location?: unknown;
  contact?: unknown;
  media_group_id?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}

export async function sendMessage(
  chatId: string | number,
  text: string,
  opts: { messageThreadId?: number | null; ctx?: CallCtx } = {},
): Promise<TgMessage> {
  const payload: Record<string, unknown> = {
    chat_id: String(chatId),
    text: escapeHtml(text),
    parse_mode: 'HTML',
  };
  if (opts.messageThreadId != null) payload.message_thread_id = opts.messageThreadId;
  return call<TgMessage>('sendMessage', payload, opts.ctx ?? {});
}

/**
 * Копия сообщения клиента в чат менеджеров: фото, голосовое или файл долетают
 * как есть, вместе с подписью. Пересылаем именно copyMessage, а не forwardMessage,
 * чтобы в топике не светилась пометка «переслано от» с личным профилем клиента.
 */
export async function copyMessage(
  chatId: string | number,
  fromChatId: string | number,
  messageId: number,
  opts: { messageThreadId?: number | null; ctx?: CallCtx } = {},
): Promise<{ message_id: number }> {
  const payload: Record<string, unknown> = {
    chat_id: String(chatId),
    from_chat_id: String(fromChatId),
    message_id: messageId,
  };
  if (opts.messageThreadId != null) payload.message_thread_id = opts.messageThreadId;
  return call<{ message_id: number }>('copyMessage', payload, opts.ctx ?? {});
}

/** Загружает фото из другого канала в топик менеджеров. */
export async function sendPhotoBytes(
  chatId: string | number,
  bytes: Uint8Array,
  opts: { messageThreadId?: number | null; caption?: string; mimeType?: string; ctx?: CallCtx } = {},
): Promise<TgMessage> {
  const payload: Record<string, string | number> = { chat_id: String(chatId) };
  if (opts.messageThreadId != null) payload.message_thread_id = opts.messageThreadId;
  if (opts.caption) {
    payload.caption = escapeHtml(opts.caption).slice(0, 1024);
    payload.parse_mode = 'HTML';
  }
  const mimeType = opts.mimeType || 'image/jpeg';
  const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
  return callWithFile<TgMessage>('sendPhoto', payload, { field: 'photo', bytes, filename: `whatsapp-photo.${ext}`, mimeType }, opts.ctx);
}

/** Загружает голосовое из WhatsApp в топик менеджеров для проверки расшифровки. */
export async function sendVoiceBytes(
  chatId: string | number,
  bytes: Uint8Array,
  opts: { messageThreadId?: number | null; caption?: string; mimeType?: string; ctx?: CallCtx } = {},
): Promise<TgMessage> {
  const payload: Record<string, string | number> = { chat_id: String(chatId) };
  if (opts.messageThreadId != null) payload.message_thread_id = opts.messageThreadId;
  if (opts.caption) {
    payload.caption = escapeHtml(opts.caption).slice(0, 1024);
    payload.parse_mode = 'HTML';
  }
  const mimeType = opts.mimeType || 'audio/ogg';
  const isVoiceFormat = /audio\/(ogg|opus)/i.test(mimeType);
  return callWithFile<TgMessage>(
    isVoiceFormat ? 'sendVoice' : 'sendDocument',
    payload,
    {
      field: isVoiceFormat ? 'voice' : 'document',
      bytes,
      filename: isVoiceFormat ? 'whatsapp-voice.ogg' : 'whatsapp-audio',
      mimeType,
    },
    opts.ctx,
  );
}

export async function createForumTopic(name: string, ctx: CallCtx = {}): Promise<{ message_thread_id: number }> {
  return call<{ message_thread_id: number }>(
    'createForumTopic',
    { chat_id: config.telegram.managerChatId, name: name.slice(0, 128) },
    ctx,
  );
}

export async function getFile(fileId: string, ctx: CallCtx = {}): Promise<{ file_path?: string; file_size?: number }> {
  return call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId }, ctx);
}

/**
 * Скачивание файла бота. Отдельно от `call`, потому что тело здесь бинарное,
 * а адрес другой: /file/bot<TOKEN>/<file_path> вместо /bot<TOKEN>/<method>.
 */
export async function downloadFile(
  filePath: string,
  ctx: CallCtx = {},
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<Buffer> {
  const url = `${config.telegram.apiBase}/file/bot${config.telegram.botToken}/${filePath}`;
  return tracked(
    { service: 'telegram', operation: 'downloadFile', threadId: ctx.threadId, runId: ctx.runId, request: { filePath } },
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new ExternalError('telegram', 'downloadFile', `HTTP ${res.status}: ${summarizeBody(text)}`, res.status);
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        if (opts.maxBytes && buffer.length > opts.maxBytes) {
          throw new ExternalError(
            'telegram',
            'downloadFile',
            `Файл ${buffer.length} байт больше лимита ${opts.maxBytes}`,
            res.status,
          );
        }
        return { value: buffer, httpStatus: res.status, response: { bytes: buffer.length } };
      } catch (err) {
        if (err instanceof ExternalError) throw err;
        if ((err as Error)?.name === 'AbortError') {
          throw new ExternalError('telegram', 'downloadFile', `Таймаут ${opts.timeoutMs ?? 30_000} мс`);
        }
        throw new ExternalError('telegram', 'downloadFile', `Сетевая ошибка: ${(err as Error)?.message ?? String(err)}`);
      } finally {
        clearTimeout(timer);
      }
    },
  );
}

export async function setWebhook(url: string): Promise<void> {
  await call('setWebhook', {
    url,
    secret_token: config.telegram.webhookSecret,
    allowed_updates: ['message'],
    drop_pending_updates: false,
  });
}

/** используется как health-check, поэтому без ретраев и с коротким таймаутом */
export async function getMe(): Promise<{ id: number; username: string }> {
  return call<{ id: number; username: string }>('getMe', {}, {}, { retries: 0, timeoutMs: 8_000 });
}
