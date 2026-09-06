import { config } from '../config.js';
import { bus } from '../bus.js';
import * as db from '../db.js';
import { log, errorMessage } from '../logger.js';
import { executeRun, type RunInput } from './pipeline.js';
import type { Run, Thread } from '../types.js';

interface ChatState {
  threadId: string;
  /** сообщения клиента, на которые ещё не отправлен ответ */
  buffer: RunInput[];
  timer: NodeJS.Timeout | null;
  generation: number;
  active: { run: Run; controller: AbortController } | null;
  /** прогон, вытесненный новым сообщением: свяжем его с будущим прогоном */
  pendingSupersededRunId?: string;
}

const states = new Map<string, ChatState>();

function stateFor(threadId: string): ChatState {
  let state = states.get(threadId);
  if (!state) {
    state = { threadId, buffer: [], timer: null, generation: 0, active: null };
    states.set(threadId, state);
  }
  return state;
}

function publishState(state: ChatState) {
  bus.publish({
    type: 'orchestrator.state',
    threadId: state.threadId,
    buffered: state.buffer.length,
    activeRunId: state.active?.run.id ?? null,
  });
}

/**
 * Приём сообщения клиента.
 *
 * Ключевое правило задачи: если сообщение пришло, пока LLM ещё думает над
 * предыдущим, текущий прогон отменяется, а новый запускается уже по ВСЕМ
 * N накопленным сообщениям клиента.
 */
export function enqueue(thread: Thread, message: RunInput): void {
  const state = stateFor(thread.id);

  state.buffer.push(message);
  if (state.buffer.length > config.orchestrator.maxBatch) {
    state.buffer.splice(0, state.buffer.length - config.orchestrator.maxBatch);
  }
  state.generation += 1;

  // отменяем текущий прогон — он уже неактуален
  if (state.active) {
    const superseded = state.active;
    superseded.controller.abort();
    state.active = null;
    log.info('прогон вытеснен новым сообщением', { runId: superseded.run.id, threadId: thread.id });
    void db
      .updateRun(superseded.run.id, { status: 'superseded' })
      .catch((err) => log.warn('не удалось пометить прогон superseded', errorMessage(err)));
    state.pendingSupersededRunId = superseded.run.id;
  }

  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    void startRun(thread.id).catch((err) => log.error('startRun упал', errorMessage(err)));
  }, config.orchestrator.debounceMs);

  publishState(state);
}

async function startRun(threadId: string): Promise<void> {
  const state = stateFor(threadId);
  if (!state.buffer.length) return;

  const thread = await db.getThread(threadId);
  if (!thread) {
    log.warn('тред исчез перед стартом прогона', { threadId });
    state.buffer = [];
    return;
  }
  if (thread.mode === 'human') {
    // менеджер забрал диалог себе — LLM не вмешивается
    state.buffer = [];
    publishState(state);
    return;
  }

  const snapshot = [...state.buffer];
  const generation = state.generation;

  const run = await db.insertRun({
    thread_id: thread.id,
    generation,
    input_message_ids: snapshot.map((m) => m.id),
    input_texts: snapshot.map((m) => m.text),
    llm_model: config.llm.model,
  });

  // связываем вытесненный прогон с новым — UI рисует цепочку
  const supersededId = state.pendingSupersededRunId;
  if (supersededId) {
    state.pendingSupersededRunId = undefined;
    void db.updateRun(supersededId, { superseded_by: run.id }).catch(() => undefined);
  }

  const controller = new AbortController();
  state.active = { run, controller };
  publishState(state);

  try {
    const outcome = await executeRun({ run, thread, inputs: snapshot, signal: controller.signal });
    if (outcome.delivered) {
      const answered = new Set(snapshot.map((m) => m.id));
      state.buffer = state.buffer.filter((m) => !answered.has(m.id));
    }
  } catch (err) {
    log.error('executeRun выбросил необработанную ошибку', errorMessage(err));
    const answered = new Set(snapshot.map((m) => m.id));
    state.buffer = state.buffer.filter((m) => !answered.has(m.id));
  } finally {
    if (state.active?.run.id === run.id) state.active = null;
    publishState(state);
    // если пока мы работали, накопились новые сообщения и таймер уже отработал —
    // подхватываем их следующим прогоном
    if (state.buffer.length && !state.timer && !state.active) {
      state.timer = setTimeout(() => {
        state.timer = null;
        void startRun(threadId).catch((e) => log.error('startRun (догоняющий) упал', errorMessage(e)));
      }, config.orchestrator.debounceMs);
    }
  }
}

/** Отмена активного прогона — например, когда менеджер вручную забирает диалог */
export function cancelActive(threadId: string, reason = 'отменено вручную'): void {
  const state = states.get(threadId);
  if (!state) return;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.active) {
    state.active.controller.abort();
    void db
      .updateRun(state.active.run.id, { status: 'cancelled', error_message: reason, finished_at: new Date().toISOString() })
      .catch(() => undefined);
    state.active = null;
  }
  state.buffer = [];
  publishState(state);
}

/** Снимок состояния оркестратора для UI */
export function orchestratorSnapshot() {
  return [...states.values()].map((state) => ({
    threadId: state.threadId,
    buffered: state.buffer.length,
    bufferedTexts: state.buffer.map((m) => m.text),
    activeRunId: state.active?.run.id ?? null,
    debounceArmed: state.timer !== null,
  }));
}
