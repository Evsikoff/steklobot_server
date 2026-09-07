import { config } from './config.js';
import * as db from './db.js';
import { enqueue, cancelActive } from './orchestrator/index.js';
import { sendCustomerText, whatsappChatId } from './services/customerMessaging.js';
import * as tg from './services/telegram.js';
import { transcribeReadiness, transcribeVoice } from './services/transcribe.js';
import { describeCarPhoto, photoSummary, photoToPromptText, visionReadiness } from './services/vision.js';
import * as wa from './services/whatsapp.js';
import { errorMessage, log } from './logger.js';
import type { Thread } from './types.js';

interface Recognized {
  text: string;
  meta: Record<string, unknown>;
  mirrorPrefix: string;
  customerReply: string;
  bytes: Buffer;
  mimeType: string;
  kind: 'photo' | 'voice';
}

interface DownloadedMedia {
  bytes: Buffer;
  mimeType: string;
  kind: 'photo' | 'voice';
}

interface Recognition {
  result: Recognized | null;
  reason: string | null;
  /** Оригинал нужен менеджеру, даже если само распознавание не удалось. */
  media: DownloadedMedia | null;
}

const seenMessageIds = new Map<string, number>();
const MESSAGE_ID_TTL_MS = 24 * 60 * 60 * 1000;

function markSeen(messageId: string): boolean {
  const now = Date.now();
  for (const [id, at] of seenMessageIds) if (now - at > MESSAGE_ID_TTL_MS) seenMessageIds.delete(id);
  if (seenMessageIds.has(messageId)) return false;
  seenMessageIds.set(messageId, now);
  return true;
}

function quoteForCustomer(text: string, maxLength = 700): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizeMimeType(value: string, fallback: string): string {
  return (value || fallback).split(';', 1)[0].trim().toLowerCase();
}

async function ensureWhatsAppThread(from: string, contactName: string | null): Promise<Thread> {
  const chatId = whatsappChatId(from);
  let thread = await db.findThreadByChatId(chatId);
  const name = contactName?.trim() || `WhatsApp +${from}`;

  if (!thread) {
    let topicId: number | null = null;
    try {
      const topic = await tg.createForumTopic(`${name} · WA +${from}`);
      topicId = topic.message_thread_id;
    } catch (err) {
      log.warn('не удалось создать топик для WhatsApp, тред создаётся без него', errorMessage(err));
    }
    try {
      thread = await db.createThread({
        customer_chat_id: chatId,
        customer_name: name,
        customer_username: null,
        topic_id: topicId,
      });
    } catch (err) {
      // Два webhook одного нового клиента могут обрабатываться параллельно.
      // Уникальный customer_chat_id оставит один тред — используем его.
      thread = await db.findThreadByChatId(chatId);
      if (!thread) throw err;
    }
  } else if (thread.topic_id == null) {
    try {
      const topic = await tg.createForumTopic(`${name} · WA +${from}`, { threadId: thread.id });
      thread = await db.updateThread(thread.id, { topic_id: topic.message_thread_id });
    } catch (err) {
      log.warn('повторная попытка создать топик WhatsApp не удалась', errorMessage(err));
    }
  }
  return thread;
}

function textOf(message: wa.WaMessage): string {
  if (message.type === 'text') return message.text?.body?.trim() ?? '';
  if (message.type === 'button') return message.button?.text?.trim() || message.button?.payload?.trim() || '';
  if (message.type === 'interactive') {
    return (
      message.interactive?.button_reply?.title?.trim() ||
      message.interactive?.list_reply?.title?.trim() ||
      message.interactive?.button_reply?.id?.trim() ||
      message.interactive?.list_reply?.id?.trim() ||
      ''
    );
  }
  return '';
}

async function recognizeMedia(thread: Thread, message: wa.WaMessage): Promise<Recognition> {
  if (message.type === 'audio' && message.audio?.id) {
    let downloaded: DownloadedMedia | null = null;
    try {
      const media = await wa.downloadMedia(message.audio.id, { threadId: thread.id }, { maxBytes: config.transcribe.maxFileBytes });
      const mimeType = normalizeMimeType(media.mimeType || message.audio.mime_type || '', 'audio/ogg');
      downloaded = { bytes: media.bytes, mimeType, kind: 'voice' };
      const ready = transcribeReadiness();
      if (!ready.ok) return { result: null, reason: ready.reason, media: downloaded };
      const transcript = await transcribeVoice(media.bytes, { threadId: thread.id, mimeType });
      return {
        result: {
          text: transcript.text,
          meta: { source: 'voice', channel: 'whatsapp', mediaId: message.audio.id },
          mirrorPrefix: '🎤 WhatsApp, расшифровка голосового',
          customerReply: `Расшифровал голосовое: «${quoteForCustomer(transcript.text)}». Использую этот текст в заявке.`,
          bytes: media.bytes,
          mimeType,
          kind: 'voice',
        },
        reason: null,
        media: downloaded,
      };
    } catch (err) {
      const reason = errorMessage(err);
      log.warn('не удалось распознать голосовое WhatsApp, отдаём менеджеру', { threadId: thread.id, error: reason });
      return { result: null, reason, media: downloaded };
    }
  }

  if (message.type === 'image' && message.image?.id) {
    let downloaded: DownloadedMedia | null = null;
    try {
      const media = await wa.downloadMedia(message.image.id, { threadId: thread.id }, { maxBytes: config.vision.maxFileBytes });
      const mimeType = normalizeMimeType(media.mimeType || message.image.mime_type || '', 'image/jpeg');
      downloaded = { bytes: media.bytes, mimeType, kind: 'photo' };
      const ready = visionReadiness();
      if (!ready.ok) return { result: null, reason: ready.reason, media: downloaded };
      const photo = await describeCarPhoto(media.bytes, mimeType, { threadId: thread.id });
      if (!photo.isCar || (!photo.make && !photo.model)) {
        const reason = photo.isCar ? 'модель не смогла определить марку' : 'на снимке не видно автомобиля';
        return { result: null, reason, media: downloaded };
      }
      const caption = message.image.caption?.trim() ?? '';
      return {
        result: {
          text: [caption, photoToPromptText(photo)].filter(Boolean).join('\n'),
          meta: { source: 'photo', channel: 'whatsapp', mediaId: message.image.id, vision: photo },
          mirrorPrefix: `🖼 WhatsApp, распознано на фото (${photoSummary(photo)})`,
          customerReply: `Распознал автомобиль по фото: ${photoSummary(photo)}. Использую эти данные в заявке.`,
          bytes: media.bytes,
          mimeType,
          kind: 'photo',
        },
        reason: null,
        media: downloaded,
      };
    } catch (err) {
      const reason = errorMessage(err);
      log.warn('не удалось распознать фото WhatsApp, отдаём менеджеру', { threadId: thread.id, error: reason });
      return { result: null, reason, media: downloaded };
    }
  }

  return { result: null, reason: null, media: null };
}

async function sendQuickReply(thread: Thread, recognized: Recognized, recognitionMs: number): Promise<void> {
  try {
    const sent = await sendCustomerText(thread, recognized.customerReply);
    await db.insertMessage({
      thread_id: thread.id,
      role: 'assistant',
      text: recognized.customerReply,
      meta: {
        recognitionAck: true,
        source: recognized.meta.source ?? null,
        recognitionMs,
        channel: sent.channel,
        providerMessageId: sent.providerMessageId,
      },
    });
    await db.updateThread(thread.id, {
      last_message_at: new Date().toISOString(),
      last_message_text: recognized.customerReply,
    });
  } catch (err) {
    log.warn('не удалось отправить быстрое подтверждение в WhatsApp', errorMessage(err));
  }
}

async function mirrorMedia(thread: Thread, media: DownloadedMedia): Promise<void> {
  const opts = {
    messageThreadId: thread.topic_id,
    caption: 'Оригинал сообщения клиента из WhatsApp',
    mimeType: media.mimeType,
    ctx: { threadId: thread.id },
  };
  const upload =
    media.kind === 'photo'
      ? tg.sendPhotoBytes(config.telegram.managerChatId, media.bytes, opts)
      : tg.sendVoiceBytes(config.telegram.managerChatId, media.bytes, opts);
  await upload.catch((err) => log.warn('не удалось загрузить медиа WhatsApp в топик менеджеров', errorMessage(err)));
}

async function handUnreadableToManager(
  thread: Thread,
  message: wa.WaMessage,
  reason: string | null,
  media: DownloadedMedia | null,
): Promise<void> {
  const typeNames: Record<string, string> = {
    image: 'фото',
    audio: 'голосовое или аудио',
    video: 'видео',
    document: 'файл',
    sticker: 'стикер',
    location: 'геопозицию',
    contacts: 'контакт',
  };
  const name = typeNames[message.type] ?? `сообщение типа ${message.type}`;
  const caption = message.image?.caption?.trim() || message.document?.caption?.trim() || '';
  const marker = `[${name}]`;
  const text = caption ? `${caption}\n${marker}` : marker;

  await db.insertMessage({
    thread_id: thread.id,
    role: 'customer',
    text,
    meta: { channel: 'whatsapp', attachment: name, providerMessageId: message.id, failure: reason },
  });
  await db.updateThread(thread.id, { mode: 'human', last_message_at: new Date().toISOString(), last_message_text: text });
  cancelActive(thread.id, 'клиент WhatsApp прислал нераспознанное вложение');
  await db.insertEscalation({
    thread_id: thread.id,
    run_id: null,
    reason: 'attachment_received',
    summary: `Клиент WhatsApp прислал ${name}${caption ? ` с подписью: ${caption}` : ''}.${reason ? ` Распознать не удалось: ${reason}.` : ''}`,
    context: { channel: 'whatsapp', type: message.type, providerMessageId: message.id },
  });

  if (media) await mirrorMedia(thread, media);

  await tg
    .sendMessage(
      config.telegram.managerChatId,
      `👤 WhatsApp: клиент прислал ${name}; дальше отвечает менеджер.${reason ? ` Распознать не удалось: ${reason}.` : ''}`,
      { messageThreadId: thread.topic_id, ctx: { threadId: thread.id } },
    )
    .catch((err) => log.warn('не удалось предупредить менеджера о сообщении WhatsApp', errorMessage(err)));

  await sendCustomerText(thread, `Я не смог обработать ${name} автоматически — передал сообщение менеджеру, он ответит здесь же.`).catch(
    (err) => log.warn('не удалось ответить клиенту WhatsApp на вложение', errorMessage(err)),
  );
}

async function handleMessage(event: wa.IncomingWaMessage): Promise<void> {
  const { message } = event;
  if (!markSeen(message.id)) return;
  try {
    if (event.phoneNumberId && event.phoneNumberId !== config.whatsapp.phoneNumberId) {
      log.warn('проигнорировано сообщение для другого WhatsApp Phone Number ID', {
        received: event.phoneNumberId,
        configured: config.whatsapp.phoneNumberId,
      });
      return;
    }

    const thread = await ensureWhatsAppThread(message.from, event.contactName);
    const recognitionStartedAt = Date.now();
    const recognition = await recognizeMedia(thread, message);
    const recognized = recognition.result;
    const recognitionMs = Date.now() - recognitionStartedAt;
    const text = recognized?.text || textOf(message);

    if (!text) {
      await handUnreadableToManager(thread, message, recognition.reason, recognition.media);
      return;
    }

    const saved = await db.insertMessage({
      thread_id: thread.id,
      role: 'customer',
      text,
      meta: {
        ...(recognized?.meta ?? {}),
        channel: 'whatsapp',
        providerMessageId: message.id,
        whatsappTimestamp: message.timestamp,
      },
    });
    await db.updateThread(thread.id, { last_message_at: new Date().toISOString(), last_message_text: text });

    if (recognized && config.recognition.quickReplyMs > 0 && recognitionMs <= config.recognition.quickReplyMs) {
      await sendQuickReply(thread, recognized, recognitionMs);
    }

    if (recognition.media) await mirrorMedia(thread, recognition.media);
    await tg
      .sendMessage(config.telegram.managerChatId, `${recognized ? recognized.mirrorPrefix : '👤 WhatsApp, клиент'}: ${text}`, {
        messageThreadId: thread.topic_id,
        ctx: { threadId: thread.id },
      })
      .catch((err) => log.warn('не удалось продублировать сообщение WhatsApp менеджеру', errorMessage(err)));

    const currentThread = (await db.getThread(thread.id)) ?? thread;
    if (currentThread.mode === 'ai') enqueue(currentThread, { id: saved.id, text });
  } catch (err) {
    seenMessageIds.delete(message.id);
    throw err;
  }
}

export async function handleWhatsAppWebhook(payload: wa.WaWebhookPayload): Promise<void> {
  const messages = wa.extractIncomingMessages(payload);
  for (const event of messages) {
    await handleMessage(event).catch((err) =>
      log.error('ошибка обработки сообщения WhatsApp', {
        messageId: event.message.id,
        from: event.message.from,
        error: errorMessage(err),
      }),
    );
  }
}
