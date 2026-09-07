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

    const header = needsManager
      ? `👤 Клиент прислал ${name} — бот такое не читает, дальше отвечает менеджер.`
      : `👤 Клиент прислал ${name}.`;
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
  const text = textOf(message);
  const attachment = attachmentOf(message);

  // фото с подписью тоже сюда: подпись бот прочитает, а картинку — нет,
  // и отвечать по половине заявки хуже, чем отдать её менеджеру
  if (attachment || !text) {
    await handleUnreadableMessage(thread, message, attachment);
    return;
  }

  const saved = await db.insertMessage({
    thread_id: thread.id,
    role: 'customer',
    text,
    tg_message_id: message.message_id,
    meta,
  });

  await db.updateThread(thread.id, { last_message_at: new Date().toISOString(), last_message_text: text });

  if (thread.topic_id != null) {
    await tg
      .sendMessage(config.telegram.managerChatId, `${mirrorPrefix}: ${text}`, {
        messageThreadId: thread.topic_id,
        ctx: { threadId: thread.id },
      })
      .catch((err) => log.warn('не удалось продублировать сообщение клиента в топик', errorMessage(err)));
  }

  if (thread.mode === 'ai') {
    enqueue(thread, { id: saved.id, text });
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
