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
