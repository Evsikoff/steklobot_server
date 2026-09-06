import { config } from './config.js';
import * as db from './db.js';
import * as tg from './services/telegram.js';
import { enqueue, cancelActive } from './orchestrator/index.js';
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

/** Сообщение от клиента в личке бота */
export async function handleCustomerMessage(message: tg.TgMessage): Promise<void> {
  const thread = await ensureThread(message);
  const text = textOf(message);

  if (!text) {
    if (thread.topic_id != null) {
      await tg
        .sendMessage(config.telegram.managerChatId, '👤 Клиент прислал вложение без текста — нужен ответ менеджера.', {
          messageThreadId: thread.topic_id,
          ctx: { threadId: thread.id },
        })
        .catch(() => undefined);
    }
    await tg
      .sendMessage(thread.customer_chat_id, 'Я пока понимаю только текст. Опишите, пожалуйста, запрос сообщением.', {
        ctx: { threadId: thread.id },
      })
      .catch(() => undefined);
    return;
  }

  const saved = await db.insertMessage({
    thread_id: thread.id,
    role: 'customer',
    text,
    tg_message_id: message.message_id,
  });

  await db.updateThread(thread.id, { last_message_at: new Date().toISOString(), last_message_text: text });

  if (thread.topic_id != null) {
    await tg
      .sendMessage(config.telegram.managerChatId, `👤 Клиент: ${text}`, {
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
