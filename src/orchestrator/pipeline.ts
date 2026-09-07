import { config } from '../config.js';
import * as db from '../db.js';
import { log, errorMessage } from '../logger.js';
import { composeReply, fallbackReply, type ComposeResult } from '../domain/replyBuilder.js';
import { loadPriceList } from '../services/priceList.js';
import { activeProvider, describeModel, type Turn } from '../services/llm/index.js';
import { buildRepairPrompt, buildUserPrompt } from '../services/llm/prompt.js';
import { validateLlmJson } from './jsonGuard.js';
import * as tg from '../services/telegram.js';
import type { Run, RunStage, Thread } from '../types.js';

export class SupersededError extends Error {
  constructor(message = 'Прогон заменён более новым') {
    super(message);
    this.name = 'SupersededError';
  }
}

export interface RunInput {
  id: number;
  text: string;
}

export interface RunOutcome {
  /** true — ответ реально доставлен клиенту, входные сообщения можно считать обработанными */
  delivered: boolean;
}

/** порядковый номер этапа внутри прогона: метки времени могут совпасть до миллисекунды */
const seqByRun = new Map<string, number>();

function stageEvent(
  run: Run,
  stage: RunStage,
  message: string,
  payload: Record<string, unknown> = {},
  durationMs: number | null = null,
  level: 'info' | 'warn' | 'error' = 'info',
) {
  const seq = (seqByRun.get(run.id) ?? 0) + 1;
  seqByRun.set(run.id, seq);
  void db.insertRunEvent({
    run_id: run.id,
    thread_id: run.thread_id,
    seq,
    stage,
    level,
    message,
    payload,
    duration_ms: durationMs,
    created_at: new Date().toISOString(),
  });
}

function ensureAlive(signal: AbortSignal) {
  if (signal.aborted) throw new SupersededError();
}

/**
 * Один прогон оркестратора: контекст → LLM → проверка JSON (с переспросом)
 * → сборка ответа → сохранение → доставка.
 * Каждый шаг публикует run_event, из которых UI рисует таймлайн.
 */
export async function executeRun(params: {
  run: Run;
  thread: Thread;
  inputs: RunInput[];
  signal: AbortSignal;
}): Promise<RunOutcome> {
  const { thread, inputs, signal } = params;
  let run = params.run;
  const startedAt = Date.now();

  run = await db.updateRun(run.id, { status: 'running', started_at: new Date().toISOString() });
  stageEvent(run, 'queued', `В прогон вошло сообщений: ${inputs.length}`, { texts: inputs.map((i) => i.text) });

  const incomingText = inputs.map((i) => i.text).join('\n');
  let composed: ComposeResult;
  let attempts = 0;

  try {
    // ------------------------------------------------------------- контекст
    const contextStarted = Date.now();
    const inputIds = new Set(inputs.map((i) => i.id));
    const [allMessages, price] = await Promise.all([
      db.listMessages(thread.id, config.orchestrator.historyLimit + inputs.length + 10),
      loadPriceList({ threadId: thread.id, runId: run.id, signal }),
    ]);
    ensureAlive(signal);

    const history = allMessages
      .filter((m) => !inputIds.has(m.id) && m.role !== 'system')
      .slice(-config.orchestrator.historyLimit)
      .map((m) => ({ role: m.role, text: m.text }));

    stageEvent(
      run,
      'context',
      price.available
        ? `История: ${history.length} сообщ., прайс: ${price.rows.length} строк${price.fromCache ? ' (из кэша)' : ''}`
        : 'Прайс недоступен — ответ будет эскалирован менеджеру',
      { historySize: history.length, priceRows: price.rows.length, priceFromCache: price.fromCache, priceError: price.error },
      Date.now() - contextStarted,
      price.available ? 'info' : 'warn',
    );

    // ------------------------------------------------- LLM + проверка JSON
    const turns: Turn[] = [
      {
        role: 'user',
        text: buildUserPrompt({
          priceListAvailable: price.available,
          priceRows: price.rows,
          history,
          incoming: inputs.map((i) => i.text),
        }),
      },
    ];

    // провайдер фиксируется на весь прогон: переключение в панели во время
    // работы не должно менять модель на середине цепочки переспросов
    const provider = activeProvider();
    const modelLabel = describeModel(provider.id, provider.model());
    await db.updateRun(run.id, { llm_model: modelLabel });

    const maxAttempts = config.llm.maxJsonRetries + 1;
    let answer: ReturnType<typeof validateLlmJson> | null = null;
    let lastRaw = '';
    let lastProblem = '';

    while (attempts < maxAttempts) {
      attempts++;
      ensureAlive(signal);

      const llmStarted = Date.now();
      stageEvent(run, 'llm_request', `Запрос к ${provider.label} (${provider.model()}), попытка ${attempts}/${maxAttempts}`, {
        attempt: attempts,
        turns: turns.length,
        provider: provider.id,
        model: provider.model(),
      });

      const result = await provider.generate(turns, { threadId: thread.id, runId: run.id, signal, attempt: attempts });
      lastRaw = result.text;
      ensureAlive(signal);

      stageEvent(
        run,
        'llm_response',
        `Ответ получен за ${Date.now() - llmStarted} мс`,
        { attempt: attempts, finishReason: result.finishReason, usage: result.usage, preview: result.text.slice(0, 500) },
        Date.now() - llmStarted,
      );

      const validated = validateLlmJson(result.text);
      if (validated.ok) {
        stageEvent(run, 'json_valid', `JSON валиден (попытка ${attempts})`, {
          attempt: attempts,
          lookupStatus: validated.value.lookupStatus,
          matchedPriceIds: validated.value.matchedPriceIds,
          selection: validated.value.selection,
        });
        answer = validated;
        break;
      }

      lastProblem = validated.problem;
      stageEvent(
        run,
        'json_invalid',
        `Невалидный JSON: ${validated.problem}`,
        { attempt: attempts, problem: validated.problem, raw: result.text.slice(0, 1000) },
        null,
        'warn',
      );

      if (attempts < maxAttempts) {
        turns.push({ role: 'model', text: result.text });
        turns.push({ role: 'user', text: buildRepairPrompt(result.text, validated.problem) });
      }
    }

    await db.updateRun(run.id, { attempts, llm_raw: lastRaw });

    // -------------------------------------------------------- сборка ответа
    const composeStarted = Date.now();
    if (answer && answer.ok) {
      composed = composeReply({
        answer: answer.value,
        priceRows: price.rows,
        priceListAvailable: price.available,
        incomingText,
      });
    } else {
      composed = fallbackReply(
        `Модель не вернула валидный JSON за ${attempts} попыт(ок). Последняя причина: ${lastProblem || 'неизвестно'}`,
      );
    }
    stageEvent(
      run,
      'compose',
      `Ответ собран (${composed.lookupStatus}${composed.matchedRows.length ? `, позиций: ${composed.matchedRows.length}` : ''})`,
      { lookupStatus: composed.lookupStatus, matchedIds: composed.matchedRows.map((r) => r.id), escalate: composed.escalate },
      Date.now() - composeStarted,
    );

    ensureAlive(signal);

    // проверяем, не переключил ли менеджер тред в ручной режим прямо во время прогона
    const currentThread = (await db.getThread(thread.id)) ?? thread;
    if (currentThread.mode === 'human' && composed.nextMode === 'ai') {
      stageEvent(run, 'failed', 'Менеджер перевёл диалог в ручной режим — автоответ отменён', {}, null, 'warn');
      await db.updateRun(run.id, {
        status: 'cancelled',
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        reply: composed.reply,
        lookup_status: composed.lookupStatus,
        error_stage: 'deliver',
        error_message: 'Диалог переведён в ручной режим',
      });
      return { delivered: true };
    }

    // ------------------------------------------------------------ доставка
    // с этого момента прогон считается зафиксированным: даже если придёт
    // новое сообщение, ответ уже уходит клиенту и обрывать его нельзя.
    const deliverStarted = Date.now();
    const sent = await tg.sendMessage(thread.customer_chat_id, composed.reply, {
      ctx: { threadId: thread.id, runId: run.id },
    });

    await db.insertMessage({
      thread_id: thread.id,
      role: 'assistant',
      text: composed.reply,
      tg_message_id: sent.message_id,
      run_id: run.id,
      meta: { lookupStatus: composed.lookupStatus, matchedPriceIds: composed.matchedRows.map((r) => r.id) },
    });

    await db.updateThread(thread.id, {
      mode: composed.nextMode,
      last_message_at: new Date().toISOString(),
      last_message_text: composed.reply,
    });

    if (thread.topic_id != null) {
      await tg
        .sendMessage(config.telegram.managerChatId, `🤖 LLM: ${composed.reply}`, {
          messageThreadId: thread.topic_id,
          ctx: { threadId: thread.id, runId: run.id },
        })
        .catch((err) => log.warn('не удалось продублировать ответ в топик', errorMessage(err)));
    }

    stageEvent(run, 'deliver', 'Ответ отправлен клиенту', { tgMessageId: sent.message_id }, Date.now() - deliverStarted);

    // ---------------------------------------------------------- эскалация
    if (composed.escalate) {
      const escalation = await db.insertEscalation({
        thread_id: thread.id,
        run_id: run.id,
        reason: composed.escalate.reason,
        summary: composed.escalate.summary,
        context: { incoming: inputs.map((i) => i.text), lookupStatus: composed.lookupStatus, reply: composed.reply },
      });
      if (thread.topic_id != null) {
        await tg
          .sendMessage(
            config.telegram.managerChatId,
            `🔔 ${composed.escalate.reason}: ${composed.escalate.summary}`,
            { messageThreadId: thread.topic_id, ctx: { threadId: thread.id, runId: run.id } },
          )
          .catch((err) => log.warn('не удалось отправить алерт менеджеру', errorMessage(err)));
      }
      stageEvent(run, 'persist', `Создан запрос менеджеру: ${composed.escalate.reason}`, { escalationId: escalation.id });
    }

    await db.updateRun(run.id, {
      status: 'done',
      attempts,
      reply: composed.reply,
      parsed: answer && answer.ok ? (answer.value as unknown as Run['parsed']) : null,
      lookup_status: composed.lookupStatus,
      matched_price_ids: composed.matchedRows.map((r) => r.id),
      escalate: composed.escalate,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
    });
    stageEvent(run, 'done', `Прогон завершён за ${Date.now() - startedAt} мс`, { attempts }, Date.now() - startedAt);

    seqByRun.delete(run.id);
    return { delivered: true };
  } catch (err) {
    // отмена может прилететь изнутри fetch как ExternalError — сигнал важнее типа ошибки
    if (err instanceof SupersededError || signal.aborted) {
      stageEvent(run, 'superseded', 'Прогон остановлен: клиент прислал новое сообщение', {}, Date.now() - startedAt, 'warn');
      await db
        .updateRun(run.id, {
          status: 'superseded',
          attempts,
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
        })
        .catch(() => undefined);
      seqByRun.delete(run.id);
      return { delivered: false };
    }

    const message = errorMessage(err);
    stageEvent(run, 'failed', `Ошибка прогона: ${message}`, { error: message }, Date.now() - startedAt, 'error');
    await db
      .updateRun(run.id, {
        status: 'failed',
        attempts,
        error_stage: 'pipeline',
        error_message: message,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
      })
      .catch(() => undefined);

    // клиент не должен остаться без ответа: пробуем отдать запасной текст
    await notifyFailure(thread, run, message);
    seqByRun.delete(run.id);
    return { delivered: true };
  }
}

async function notifyFailure(thread: Thread, run: Run, message: string): Promise<void> {
  try {
    await tg.sendMessage(
      thread.customer_chat_id,
      'Извините, произошёл технический сбой. Подключаю менеджера — он ответит вам здесь же.',
      { ctx: { threadId: thread.id, runId: run.id } },
    );
    await db.updateThread(thread.id, { mode: 'human' });
    await db.insertEscalation({
      thread_id: thread.id,
      run_id: run.id,
      reason: 'pipeline_error',
      summary: message,
      context: {},
    });
    if (thread.topic_id != null) {
      await tg.sendMessage(config.telegram.managerChatId, `❌ Сбой обработки: ${message}`, {
        messageThreadId: thread.topic_id,
        ctx: { threadId: thread.id, runId: run.id },
      });
    }
  } catch (err) {
    log.error('не удалось уведомить о сбое', errorMessage(err));
  }
}
