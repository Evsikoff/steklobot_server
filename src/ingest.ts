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

/** 75 → «1:15» */
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

/** Скачивает голосовое из Telegram и расшифровывает его Gemini Transcribe Live */
async function transcribeVoiceMessage(voice: tg.TgVoice, thread: Thread): Promise<string> {
  if (voice.duration > config.transcribe.maxDurationSec) {
    throw new Error(`запись длиннее ${config.transcribe.maxDurationSec} с`);
  }
  if (voice.file_size != null && voice.file_size > config.transcribe.maxFileBytes) {
    throw new Error(`файл больше ${config.transcribe.maxFileBytes} байт`);
  }

  const audio = await fetchFile(voice.file_id, thread, config.transcribe.maxFileBytes);
  const result = await transcribeVoice(audio, { threadId: thread.id });

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

/** Сообщение от клиента в личке бота */
export async function handleCustomerMessage(message: tg.TgMessage): Promise<void> {
  const thread = await ensureThread(message);
  let text = textOf(message);
  let meta: Record<string, unknown> | undefined;
  let mirrorPrefix = '👤 Клиент';

  // голосовое без подписи — распознаём и дальше ведём как обычный текст
  if (!text && message.voice && transcribeReadiness().ok) {
    const stamp = formatDuration(message.voice.duration);
    try {
      text = await transcribeVoiceMessage(message.voice, thread);
      meta = { source: 'voice', duration_sec: message.voice.duration, file_unique_id: message.voice.file_unique_id };
      mirrorPrefix = `🎤 Клиент (голосовое ${stamp})`;
    } catch (err) {
      const reason = errorMessage(err);
      log.warn('не удалось распознать голосовое', { threadId: thread.id, error: reason });
      if (thread.topic_id != null) {
        await tg
          .sendMessage(config.telegram.managerChatId, `🎤 Клиент прислал голосовое ${stamp}, распознать не удалось: ${reason}. Нужен ответ менеджера.`, {
            messageThreadId: thread.topic_id,
            ctx: { threadId: thread.id },
          })
          .catch(() => undefined);
      }
      await tg
        .sendMessage(thread.customer_chat_id, 'Не получилось разобрать голосовое сообщение. Напишите, пожалуйста, текстом — или дождитесь менеджера.', {
          ctx: { threadId: thread.id },
        })
        .catch(() => undefined);
      return;
    }
  }

  // фото автомобиля — распознаём и добавляем блоком к подписи клиента
  const image = imageOf(message);
  if (image && visionReadiness().ok) {
    try {
      if (image.fileSize != null && image.fileSize > config.vision.maxFileBytes) {
        throw new Error(`файл больше ${config.vision.maxFileBytes} байт`);
      }
      const bytes = await fetchFile(image.fileId, thread, config.vision.maxFileBytes);
      const photo = await describeCarPhoto(bytes, image.mimeType, { threadId: thread.id });
      text = [text, photoToPromptText(photo)].filter(Boolean).join('\n');
      meta = { source: 'photo', vision: photo };
      mirrorPrefix = `🖼 Клиент (фото — ${photoSummary(photo)})`;
    } catch (err) {
      const reason = errorMessage(err);
      log.warn('не удалось распознать фото', { threadId: thread.id, error: reason });
      if (thread.topic_id != null) {
        await tg
          .sendMessage(config.telegram.managerChatId, `🖼 Клиент прислал фото, распознать не удалось: ${reason}.`, {
            messageThreadId: thread.topic_id,
            ctx: { threadId: thread.id },
          })
          .catch(() => undefined);
      }
      // с подписью диалог продолжается по тексту, без подписи — зовём менеджера
      if (!text) {
        await tg
          .sendMessage(thread.customer_chat_id, 'Не получилось разобрать фото. Напишите, пожалуйста, марку, модель и год автомобиля — или дождитесь менеджера.', {
            ctx: { threadId: thread.id },
          })
          .catch(() => undefined);
        return;
      }
    }
  }

  if (!text) {
    if (thread.topic_id != null) {
      const kind = message.voice ? `голосовое ${formatDuration(message.voice.duration)}` : 'вложение';
      await tg
        .sendMessage(config.telegram.managerChatId, `👤 Клиент прислал ${kind} без текста — нужен ответ менеджера.`, {
          messageThreadId: thread.topic_id,
          ctx: { threadId: thread.id },
        })
        .catch(() => undefined);
    }
    await tg
      .sendMessage(
        thread.customer_chat_id,
        [
          'Я пока понимаю',
          [
            'текст',
            transcribeReadiness().ok ? 'голосовые' : null,
            visionReadiness().ok ? 'фото автомобиля' : null,
          ]
            .filter(Boolean)
            .join(', '),
          '— опишите, пожалуйста, запрос сообщением.',
        ].join(' '),
        { ctx: { threadId: thread.id } },
      )
      .catch(() => undefined);
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
