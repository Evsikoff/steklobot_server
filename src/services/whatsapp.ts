import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { ExternalError, httpJson, summarizeBody, tracked } from './external.js';

interface CallCtx {
  threadId?: string | null;
  runId?: string | null;
}

export interface WaMedia {
  id: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  voice?: boolean;
  filename?: string;
}

export interface WaMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body?: string };
  image?: WaMedia;
  audio?: WaMedia;
  document?: WaMedia;
  video?: WaMedia;
  sticker?: WaMedia;
  location?: Record<string, unknown>;
  contacts?: unknown[];
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  button?: { text?: string; payload?: string };
}

export interface WaContact {
  wa_id?: string;
  profile?: { name?: string };
}

export interface WaWebhookValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: WaContact[];
  messages?: WaMessage[];
  statuses?: unknown[];
}

export interface WaWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{ field?: string; value?: WaWebhookValue }>;
  }>;
}

export interface IncomingWaMessage {
  message: WaMessage;
  contactName: string | null;
  phoneNumberId: string | null;
}

const apiBase = () => config.whatsapp.apiBase.replace(/\/+$/, '');
const apiUrl = (path: string) => `${apiBase()}/${config.whatsapp.apiVersion.replace(/^\/+/, '')}/${path.replace(/^\/+/, '')}`;

export function whatsappReadiness(): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!config.whatsapp.phoneNumberId) missing.push('WHATSAPP_PHONE_NUMBER_ID');
  if (!config.whatsapp.accessToken) missing.push('WHATSAPP_ACCESS_TOKEN');
  if (!config.whatsapp.appSecret) missing.push('WHATSAPP_APP_SECRET');
  if (!config.whatsapp.verifyToken) missing.push('WHATSAPP_VERIFY_TOKEN');
  return { ok: missing.length === 0, missing };
}

export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!config.whatsapp.appSecret || !signatureHeader?.startsWith('sha256=')) return false;
  const receivedHex = signatureHeader.slice('sha256='.length);
  if (!/^[a-f0-9]{64}$/i.test(receivedHex)) return false;
  const expected = createHmac('sha256', config.whatsapp.appSecret).update(rawBody).digest();
  const received = Buffer.from(receivedHex, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function extractIncomingMessages(payload: WaWebhookPayload): IncomingWaMessage[] {
  const result: IncomingWaMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages' || !change.value?.messages?.length) continue;
      const names = new Map(
        (change.value.contacts ?? [])
          .filter((contact): contact is WaContact & { wa_id: string } => Boolean(contact.wa_id))
          .map((contact) => [contact.wa_id, contact.profile?.name?.trim() || null]),
      );
      for (const message of change.value.messages) {
        if (!message.id || !message.from) continue;
        result.push({
          message,
          contactName: names.get(message.from) ?? null,
          phoneNumberId: change.value.metadata?.phone_number_id ?? null,
        });
      }
    }
  }
  return result;
}

export async function sendText(to: string, text: string, ctx: CallCtx = {}): Promise<{ messageId: string }> {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body: text },
  };
  const res = await httpJson(
    { service: 'whatsapp', operation: 'sendMessage', threadId: ctx.threadId, runId: ctx.runId, request: payload },
    apiUrl(`${config.whatsapp.phoneNumberId}/messages`),
    {
      method: 'POST',
      headers: { authorization: `Bearer ${config.whatsapp.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: 20_000,
    },
    { retries: 2 },
  );
  const messageId = (res.body as { messages?: Array<{ id?: string }> } | null)?.messages?.[0]?.id;
  if (!messageId) {
    throw new ExternalError('whatsapp', 'sendMessage', 'Cloud API не вернул ID отправленного сообщения', res.status, res.body);
  }
  return { messageId };
}

export async function getPhoneNumber(): Promise<{ display_phone_number?: string; verified_name?: string }> {
  const res = await httpJson(
    { service: 'whatsapp', operation: 'getPhoneNumber', request: { phoneNumberId: config.whatsapp.phoneNumberId } },
    `${apiUrl(config.whatsapp.phoneNumberId)}?fields=display_phone_number,verified_name`,
    {
      method: 'GET',
      headers: { authorization: `Bearer ${config.whatsapp.accessToken}` },
      timeoutMs: 8_000,
    },
    { retries: 0 },
  );
  return (res.body ?? {}) as { display_phone_number?: string; verified_name?: string };
}

export async function downloadMedia(
  mediaId: string,
  ctx: CallCtx = {},
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<{ bytes: Buffer; mimeType: string }> {
  const metadata = await httpJson(
    { service: 'whatsapp', operation: 'getMediaUrl', threadId: ctx.threadId, runId: ctx.runId, request: { mediaId } },
    apiUrl(mediaId),
    {
      method: 'GET',
      headers: { authorization: `Bearer ${config.whatsapp.accessToken}` },
      timeoutMs: 10_000,
    },
    { retries: 1 },
  );
  const info = metadata.body as { url?: string; mime_type?: string; file_size?: number } | null;
  if (!info?.url) {
    throw new ExternalError('whatsapp', 'getMediaUrl', 'Cloud API не вернул URL медиафайла', metadata.status, metadata.body);
  }
  if (opts.maxBytes && info.file_size && info.file_size > opts.maxBytes) {
    throw new ExternalError('whatsapp', 'downloadMedia', `Файл ${info.file_size} байт больше лимита ${opts.maxBytes}`);
  }

  const bytes = await tracked(
    { service: 'whatsapp', operation: 'downloadMedia', threadId: ctx.threadId, runId: ctx.runId, request: { mediaId } },
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
      try {
        const res = await fetch(info.url!, {
          headers: { authorization: `Bearer ${config.whatsapp.accessToken}` },
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new ExternalError('whatsapp', 'downloadMedia', `HTTP ${res.status}: ${summarizeBody(text)}`, res.status);
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        if (opts.maxBytes && buffer.length > opts.maxBytes) {
          throw new ExternalError(
            'whatsapp',
            'downloadMedia',
            `Файл ${buffer.length} байт больше лимита ${opts.maxBytes}`,
            res.status,
          );
        }
        return { value: buffer, httpStatus: res.status, response: { mediaId, bytes: buffer.length } };
      } catch (err) {
        if (err instanceof ExternalError) throw err;
        if ((err as Error)?.name === 'AbortError') {
          throw new ExternalError('whatsapp', 'downloadMedia', `Таймаут ${opts.timeoutMs ?? 30_000} мс`);
        }
        throw new ExternalError('whatsapp', 'downloadMedia', `Сетевая ошибка: ${(err as Error)?.message ?? String(err)}`);
      } finally {
        clearTimeout(timer);
      }
    },
  );

  return { bytes, mimeType: info.mime_type || 'application/octet-stream' };
}
