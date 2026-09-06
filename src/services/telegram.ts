import { config } from '../config.js';
import { httpJson } from './external.js';

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

export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  date: number;
  text?: string;
  caption?: string;
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
