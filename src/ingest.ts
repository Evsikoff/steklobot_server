import { config } from './config.js';
import * as db from './db.js';
import * as tg from './services/telegram.js';
import { enqueue, cancelActive } from './orchestrator/index.js';
import { transcribeReadiness, transcribeVoice } from './services/transcribe.js';
import { describeCarPhoto, photoSummary, photoToPromptText, visionReadiness } from './services/vision.js';
import { log, errorMessage } from './logger.js';
import type { Thread } from './types.js';

function displayName(chat: tg.TgMessage['chat'], chatId: string): string {
  const parts = [chat.first_name, chat.last_name].filter(Boolean).join(' ').trim();
  return parts || chat.username || `Клиент ${chatId}`;
}

/** Находит тред по chat.id, при необходимости заводит форум-топик в чате менеджеров */
export async function ensureThread(message: tg.TgMessage): Promise<Thread> {
  const chatId = String(message.chat.id);
  let thread = await db.findThreadByChatId(chatId);
  const name = displayName(message.chat, chatId);

  if (!thread) {
    let topicId: number | null = null;
    try {
      const topic = await tg.createForumTopic(`${name} #${chatId}`);
      topicId = topic.message_thread_id;
    } catch (err) {
      // топик не критичен для ответа клиенту — продолжаем без него, ошибка уже в журнале
      log.warn('не удалось создать топик, тред создаётся без него', errorMessage(err));
    }
    thread = await db.createThread({
      customer_chat_id: chatId,
      customer_name: name,
      customer_username: message.chat.username ?? null,
      topic_id: topicId,
    });
  } else if (thread.topic_id == null) {
    try {
      const topic = await tg.createForumTopic(`${name} #${chatId}`, { threadId: thread.id });
      thread = await db.updateThread(thread.id, { topic_id: topic.message_thread_id });
    } catch (err) {
      log.warn('повторная попытка создать топик не удалась', errorMessage(err));
    }
  }
  return thread;
}

function textOf(message: tg.TgMessage): string {
  return (message.text ?? message.caption ?? '').trim();
}

/** 75 -> 1:15 */
function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Скачивает файл клиента по file_id */
async function fetchFile(fileId: string, thread: Thread, maxBytes: number): Promise<Buffer> {
  const file = await tg.getFile(fileId, { threadId: thread.id });
  if (!file.file_path) throw new Error('Telegram не отдал путь к файлу');
  return tg.downloadFile(file.file_path, { threadId: thread.id }, { maxBytes });
}

/** Скачивает голосовое из Telegram и расшифровывает его Gemini Transcribe */
async function transcribeVoiceMessage(voice: tg.TgVoice, thread: Thread): Promise<string> {
  if (voice.duration > config.transcribe.maxDurationSec) {
    throw new Error(`запись длиннее ${config.transcribe.maxDurationSec} с`);
  }
  if (voice.file_size != null && voice.file_size > config.transcribe.maxFileBytes) {
    throw new Error(`файл больше ${config.transcribe.maxFileBytes} байт`);
  }

  const audio = await fetchFile(voice.file_id, thread, config.transcribe.maxFileBytes);
  const result = await transcribeVoice(audio, {
    threadId: thread.id,
    durationSec: voice.duration,
    mimeType: voice.mime_type || 'audio/ogg',
  });

  log.info('голосовое распознано', {
    threadId: thread.id,
    model: result.model,
    durationSec: Math.round(result.durationSec),
    chars: result.text.length,
  });
  return result.text;
}

/**
 * Картинка в сообщении: либо сжатое фото (берём самый крупный вариант),
 * либо изображение, отправленное файлом «без сжатия».
 */
function imageOf(message: tg.TgMessage): { fileId: string; mimeType: string; fileSize?: number } | null {
  const photo = message.photo?.length ? message.photo[message.photo.length - 1] : null;
  if (photo) return { fileId: photo.file_id, mimeType: 'image/jpeg', fileSize: photo.file_size };

  const doc = message.document;
  if (doc?.mime_type && /^image\/(jpeg|png|webp|heic|heif)$/i.test(doc.mime_type)) {
    return { fileId: doc.file_id, mimeType: doc.mime_type.toLowerCase(), fileSize: doc.file_size };
  }
  return null;
}

interface Recognized {
  text: string;
  meta: Record<string, unknown>;
  /** подпись к расшифровке в топике менеджеров */
  mirrorPrefix: string;
  /** короткое подтверждение результата непосредственно клиенту */
  customerReply: string;
}

function quoteForCustomer(text: string, maxLength = 700): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Голосовое и фото автомобиля бот читает сам, и заявка идёт обычным путём.
 * Пустой result — это другое вложение либо распознать не удалось: тогда
 * сообщение уходит менеджеру целиком, как и всё, что бот прочитать не может,
 * а reason объясняет менеджеру в топике, почему бот не справился.
 */
interface Recognition {
  result: Recognized | null;
  reason: string | null;
}

async function recognizeMedia(thread: Thread, message: tg.TgMessage): Promise<Recognition> {
  const caption = textOf(message);

  if (message.voice) {
    const ready = transcribeReadiness();
    if (!ready.ok) return { result: null, reason: ready.reason };
    try {
      const transcript = await transcribeVoiceMessage(message.voice, thread);
      return {
        result: {
          text: [caption, transcript].filter(Boolean).join('\n'),
          meta: { source: 'voice', duration_sec: message.voice.duration, file_unique_id: message.voice.file_unique_id },
          mirrorPrefix: `🎤 Расшифровка (голосовое ${formatDuration(message.voice.duration)})`,
          customerReply: `Расшифровал голосовое: «${quoteForCustomer(transcript)}». Использую этот текст в заявке.`,
        },
        reason: null,
      };
    } catch (err) {
      const reason = errorMessage(err);
      log.warn('не удалось распознать голосовое, отдаём менеджеру', { threadId: thread.id, error: reason });
      return { result: null, reason };
    }
  }

  const image = imageOf(message);
  if (image) {
    const ready = visionReadiness();
    if (!ready.ok) return { result: null, reason: ready.reason };
    try {
      if (image.fileSize != null && image.fileSize > config.vision.maxFileBytes) {
        throw new Error(`файл больше ${config.vision.maxFileBytes} байт`);
      }
      const bytes = await fetchFile(image.fileId, thread, config.vision.maxFileBytes);
      const photo = await describeCarPhoto(bytes, image.mimeType, { threadId: thread.id });
      // ни марки, ни модели — подбирать не по чему, пусть смотрит менеджер
      if (!photo.isCar || (!photo.make && !photo.model)) {
        const reason = photo.isCar ? 'модель не смогла определить марку' : 'на снимке не видно автомобиля';
        log.info('фото не даёт данных для подбора, отдаём менеджеру', { threadId: thread.id, reason });
        return { result: null, reason };
      }
      return {
        result: {
          text: [caption, photoToPromptText(photo)].filter(Boolean).join('\n'),
          meta: { source: 'photo', vision: photo },
          mirrorPrefix: `🖼 Распознано на фото (${photoSummary(photo)})`,
          customerReply: `Распознал автомобиль по фото: ${photoSummary(photo)}. Использую эти данные в заявке.`,
        },
        reason: null,
      };
    } catch (err) {
      const reason = errorMessage(err);
      log.warn('не удалось распознать фото, отдаём менеджеру', { threadId: thread.id, error: reason });
      return { result: null, reason };
    }
  }

  return { result: null, reason: null };
}

async function sendQuickRecognitionReply(thread: Thread, recognized: Recognized, recognitionMs: number): Promise<void> {
  try {
    const sent = await tg.sendMessage(thread.customer_chat_id, recognized.customerReply, { ctx: { threadId: thread.id } });
    await db.insertMessage({
      thread_id: thread.id,
      role: 'assistant',
      text: recognized.customerReply,
      tg_message_id: sent.message_id,
      meta: {
        recognitionAck: true,
        source: recognized.meta.source ?? null,
        recognitionMs,
      },
    });
    await db.updateThread(thread.id, {
      last_message_at: new Date().toISOString(),
      last_message_text: recognized.customerReply,
    });
    log.info('результат распознавания сразу отправлен клиенту', { threadId: thread.id, recognitionMs });
  } catch (err) {
    // Подтверждение не должно ломать основной подбор: итоговый ответ всё равно отправит пайплайн.
    log.warn('не удалось отправить клиенту быстрое подтверждение распознавания', errorMessage(err));
  }
}

/**
 * Вложения бот не читает, а фото или голосовое часто и есть сама заявка.
 * Такое сообщение копируем менеджеру целиком и отдаём ему диалог.
 * needsManager = false у стикеров и GIF: забирать диалог из-за смайлика незачем.
 * Названия — в винительном падеже: подставляются в «прислал …» и «передал … менеджеру».
 */
const ATTACHMENT_KINDS: { field: keyof tg.TgMessage; name: string; needsManager: boolean }[] = [
  { field: 'photo', name: 'фото', needsManager: true },
  { field: 'voice', name: 'голосовое сообщение', needsManager: true },
  { field: 'video_note', name: 'видеосообщение', needsManager: true },
  { field: 'video', name: 'видео', needsManager: true },
  { field: 'audio', name: 'аудио', needsManager: true },
  { field: 'document', name: 'файл', needsManager: true },
  { field: 'location', name: 'геопозицию', needsManager: true },
  { field: 'contact', name: 'контакт', needsManager: true },
  { field: 'animation', name: 'GIF', needsManager: false },
  { field: 'sticker', name: 'стикер', needsManager: false },
];

type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

const attachmentOf = (message: tg.TgMessage): AttachmentKind | null =>
  ATTACHMENT_KINDS.find((kind) => message[kind.field] != null) ?? null;

/**
 * Альбом приходит несколькими апдейтами с общим media_group_id: копию в топик
 * делаем для каждого файла, а отвечать клиенту и заводить запрос менеджеру — один раз.
 */
const seenMediaGroups = new Map<string, number>();
const MEDIA_GROUP_TTL_MS = 60_000;

function isFirstInMediaGroup(groupId: string | undefined): boolean {
  if (!groupId) return true;
  const now = Date.now();
  for (const [id, at] of seenMediaGroups) if (now - at > MEDIA_GROUP_TTL_MS) seenMediaGroups.delete(id);
  if (seenMediaGroups.has(groupId)) return false;
  seenMediaGroups.set(groupId, now);
  return true;
}

/**
 * Сообщение, которое бот прочитать не может: вложение или сообщение без текста.
 * Раньше клиент получал отписку «понимаю только текст», а менеджер — строчку в топике
 * без самого файла, и заявка терялась. Теперь файл уходит в топик как есть,
 * факт пишется в историю, а диалог переводится на менеджера.
 */
async function handleUnreadableMessage(
  thread: Thread,
  message: tg.TgMessage,
  attachment: AttachmentKind | null,
  failure: string | null = null,
): Promise<void> {
  const caption = textOf(message);
  const name = attachment?.name ?? 'вложение';
  const needsManager = attachment?.needsManager ?? true;
  const marker = `[${name}]`;
  const first = isFirstInMediaGroup(message.media_group_id);
  // топика может не быть (не создался) — тогда копия уйдёт в General, но не пропадёт
  const mirror = { messageThreadId: thread.topic_id, ctx: { threadId: thread.id } };

  if (first) {
    await db.insertMessage({
      thread_id: thread.id,
      role: 'customer',
      text: caption ? `${caption}\n${marker}` : marker,
      tg_message_id: message.message_id,
      meta: { attachment: name, mediaGroupId: message.media_group_id ?? null },
    });
    await db.updateThread(thread.id, {
      ...(needsManager ? { mode: 'human' as const } : {}),
      last_message_at: new Date().toISOString(),
      last_message_text: caption ? `${caption} ${marker}` : marker,
    });

    // без причины менеджер видит только «бот такое не читает» и не понимает,
    // сломалось распознавание или этот тип вложения бот и не должен читать
    const why = failure ? ` Распознать не удалось: ${failure}.` : '';
    const header = needsManager
      ? `👤 Клиент прислал ${name} — бот такое не читает, дальше отвечает менеджер.${why}`
      : `👤 Клиент прислал ${name}.${why}`;
    await tg
      .sendMessage(config.telegram.managerChatId, header, mirror)
      .catch((err) => log.warn('не удалось предупредить менеджера о вложении', errorMessage(err)));
  }

  // копия нужна для каждого файла: у альбома каждое фото приходит отдельным апдейтом
  const copied = await tg
    .copyMessage(config.telegram.managerChatId, thread.customer_chat_id, message.message_id, mirror)
    .catch((err) => {
      log.warn('не удалось переслать вложение менеджеру', errorMessage(err));
      return null;
    });
  if (!copied) {
    await tg
      .sendMessage(config.telegram.managerChatId, '⚠️ Вложение переслать не удалось — откройте диалог с клиентом.', mirror)
      .catch(() => undefined);
  }

  if (!needsManager || !first) return;

  // прогон по прошлым сообщениям уже не нужен: диалог ведёт человек
  cancelActive(thread.id, 'клиент прислал вложение');
  await db.insertEscalation({
    thread_id: thread.id,
    run_id: null,
    reason: 'attachment_received',
    summary: `Клиент прислал ${name}${caption ? ` с подписью: ${caption}` : ''} — бот такое не читает, нужен менеджер.`,
    context: { attachment: name, caption, tgMessageId: message.message_id },
  });

  await tg
    .sendMessage(thread.customer_chat_id, `Я пока не открываю вложения — передал ${name} менеджеру, он ответит здесь же.`, {
      ctx: { threadId: thread.id },
    })
    .catch((err) => log.warn('не удалось ответить клиенту на вложение', errorMessage(err)));
}

/** Сообщение от клиента в личке бота */
export async function handleCustomerMessage(message: tg.TgMessage): Promise<void> {
  const thread = await ensureThread(message);
  const attachment = attachmentOf(message);
  const recognitionStartedAt = Date.now();

  // голосовое и фото автомобиля бот распознаёт сам; остальные вложения — и всё,
  // что распознать не вышло, — уходят менеджеру вместе с самим файлом
  const recognition: Recognition = attachment
    ? await recognizeMedia(thread, message)
    : { result: null, reason: null };
  const recognized = recognition.result;
  const recognitionMs = Date.now() - recognitionStartedAt;
  const text = recognized ? recognized.text : textOf(message);

  if (!text || (attachment && !recognized)) {
    await handleUnreadableMessage(thread, message, attachment, recognition.reason);
    return;
  }

  const saved = await db.insertMessage({
    thread_id: thread.id,
    role: 'customer',
    text,
    tg_message_id: message.message_id,
    meta: recognized?.meta,
  });

  await db.updateThread(thread.id, { last_message_at: new Date().toISOString(), last_message_text: text });

  if (recognized && config.recognition.quickReplyMs > 0 && recognitionMs <= config.recognition.quickReplyMs) {
    await sendQuickRecognitionReply(thread, recognized, recognitionMs);
  }

  if (thread.topic_id != null) {
    const mirror = { messageThreadId: thread.topic_id, ctx: { threadId: thread.id } };
    // сам файл менеджеру тоже нужен: расшифровку можно перепроверить на слух,
    // а фото — глазами, если бот определил машину неверно
    if (recognized) {
      await tg
        .copyMessage(config.telegram.managerChatId, thread.customer_chat_id, message.message_id, mirror)
        .catch((err) => log.warn('не удалось переслать вложение в топик', errorMessage(err)));
    }
    await tg
      .sendMessage(config.telegram.managerChatId, `${recognized ? recognized.mirrorPrefix : '👤 Клиент'}: ${text}`, mirror)
      .catch((err) => log.warn('не удалось продублировать сообщение клиента в топик', errorMessage(err)));
  }

  const currentThread = (await db.getThread(thread.id)) ?? thread;
  if (currentThread.mode === 'ai') {
    enqueue(currentThread, { id: saved.id, text });
  }
}

/** Сообщение сотрудника в форум-топике чата менеджеров */
export async function handleStaffMessage(message: tg.TgMessage): Promise<void> {
  const topicId = message.message_thread_id;
  if (topicId == null) return;
  if (message.from?.is_bot) return;

  // служебные топики (General и т.п.) не относятся к диалогам с клиентами
  if (config.telegram.ignoredTopicIds.includes(topicId)) return;

  const text = textOf(message);
  if (!text) return;

  const thread = await db.findThreadByTopicId(topicId);
  if (!thread) {
    await tg
      .sendMessage(config.telegram.managerChatId, '⚠️ Диалог для этого топика не найден в базе.', {
        messageThreadId: topicId,
      })
      .catch(() => undefined);
    return;
  }

  const command = text.toLowerCase();

  if (command.startsWith('/ai')) {
    await db.setThreadMode(thread.id, 'ai');
    await db.insertMessage({ thread_id: thread.id, role: 'system', text: 'Режим переключён на AI', meta: { by: 'telegram' } });
    await tg.sendMessage(config.telegram.managerChatId, 'Бот снова отвечает автоматически.', {
      messageThreadId: topicId,
      ctx: { threadId: thread.id },
    });
    return;
  }

  if (command.startsWith('/human') || command.startsWith('/stop')) {
    cancelActive(thread.id, 'менеджер забрал диалог');
    await db.setThreadMode(thread.id, 'human');
    await db.insertMessage({ thread_id: thread.id, role: 'system', text: 'Режим переключён на ручной', meta: { by: 'telegram' } });
    await tg.sendMessage(config.telegram.managerChatId, 'Автоответы выключены, диалог ведёт менеджер.', {
      messageThreadId: topicId,
      ctx: { threadId: thread.id },
    });
    return;
  }

  // обычное сообщение сотрудника — пересылаем клиенту и переводим в ручной режим
  cancelActive(thread.id, 'ответил менеджер');
  await db.setThreadMode(thread.id, 'human');
  await sendAsManager(thread, text, message.from?.username ?? message.from?.first_name ?? 'менеджер', { mirror: false });
}

/** Отправка от имени менеджера — из Telegram-топика или из веб-интерфейса */
export async function sendAsManager(
  thread: Thread,
  text: string,
  author: string,
  opts: { mirror?: boolean } = {},
): Promise<void> {
  const sent = await tg.sendMessage(thread.customer_chat_id, text, { ctx: { threadId: thread.id } });

  await db.insertMessage({
    thread_id: thread.id,
    role: 'manager',
    text,
    tg_message_id: sent.message_id,
    meta: { author },
  });
  await db.updateThread(thread.id, { last_message_at: new Date().toISOString(), last_message_text: text });

  if (opts.mirror !== false && thread.topic_id != null) {
    await tg
      .sendMessage(config.telegram.managerChatId, `👨‍💼 ${author}: ${text}`, {
        messageThreadId: thread.topic_id,
        ctx: { threadId: thread.id },
      })
      .catch((err) => log.warn('не удалось продублировать ответ менеджера', errorMessage(err)));
  }
}

/** Точка входа для апдейта Telegram */
export async function handleUpdate(update: tg.TgUpdate): Promise<void> {
  const message = update.message;
  if (!message) return;

  if (message.chat.type === 'private') {
    await handleCustomerMessage(message);
    return;
  }

  if (String(message.chat.id) === config.telegram.managerChatId) {
    await handleStaffMessage(message);
  }
}
