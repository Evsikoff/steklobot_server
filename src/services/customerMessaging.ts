import type { Thread } from '../types.js';
import * as tg from './telegram.js';
import * as wa from './whatsapp.js';

const WHATSAPP_PREFIX = 'whatsapp:';

interface CallCtx {
  threadId?: string | null;
  runId?: string | null;
}

export interface CustomerSendResult {
  channel: 'telegram' | 'whatsapp';
  providerMessageId: string;
  telegramMessageId: number | null;
}

/**
 * Сохраняем WhatsApp ID с префиксом в существующем customer_chat_id. Это не
 * требует опасной миграции уже работающей базы и исключает коллизии с Telegram.
 */
export function whatsappChatId(waId: string): string {
  return `${WHATSAPP_PREFIX}${waId}`;
}

export function isWhatsAppThread(thread: Pick<Thread, 'customer_chat_id'>): boolean {
  return thread.customer_chat_id.startsWith(WHATSAPP_PREFIX);
}

export function whatsappRecipient(thread: Pick<Thread, 'customer_chat_id'>): string | null {
  if (!isWhatsAppThread(thread)) return null;
  const value = thread.customer_chat_id.slice(WHATSAPP_PREFIX.length).trim();
  return value || null;
}

export async function sendCustomerText(
  thread: Pick<Thread, 'customer_chat_id' | 'id'>,
  text: string,
  ctx: CallCtx = {},
): Promise<CustomerSendResult> {
  const recipient = whatsappRecipient(thread);
  if (recipient) {
    const sent = await wa.sendText(recipient, text, { threadId: ctx.threadId ?? thread.id, runId: ctx.runId });
    return { channel: 'whatsapp', providerMessageId: sent.messageId, telegramMessageId: null };
  }

  const sent = await tg.sendMessage(thread.customer_chat_id, text, {
    ctx: { threadId: ctx.threadId ?? thread.id, runId: ctx.runId },
  });
  return { channel: 'telegram', providerMessageId: String(sent.message_id), telegramMessageId: sent.message_id };
}
