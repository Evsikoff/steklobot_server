import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { bus } from './bus.js';
import { ExternalError, setExternalEventSink, tracked } from './services/external.js';
import { log } from './logger.js';
import type {
  Escalation,
  EscalationStatus,
  ExternalEvent,
  Message,
  MessageRole,
  Run,
  RunEvent,
  RunStatus,
  Thread,
  ThreadMode,
} from './types.js';

let client: SupabaseClient;

/** fetch с таймаутом: без него недоступная Supabase подвешивает запрос навсегда */
const timeoutFetch: typeof fetch = (input, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.supabase.timeoutMs);
  const external = init?.signal ?? undefined;
  const onAbort = () => controller.abort();
  external?.addEventListener('abort', onAbort, { once: true });
  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    external?.removeEventListener('abort', onAbort);
  });
};

export function initDb(): void {
  client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: timeoutFetch },
  });
  // ошибки самой Supabase попадают в шину, но не пишутся в Supabase (иначе цикл)
  setExternalEventSink((event) => {
    void client
      .from('external_events')
      .insert(event as never)
      .then(({ error }) => {
        if (error) log.warn('не удалось записать external_events', error.message);
      });
  });
}

/** Обёртка над запросом Supabase: единый учёт ошибок без записи в саму Supabase */
async function q<T>(operation: string, fn: () => PromiseLike<{ data: T | null; error: { message: string; code?: string } | null }>): Promise<T> {
  return tracked({ service: 'supabase', operation, persist: false }, async () => {
    const { data, error } = await fn();
    if (error) {
      const detail = error.message?.includes('aborted')
        ? `Supabase не ответила за ${config.supabase.timeoutMs} мс`
        : `${error.message}${error.code ? ` (${error.code})` : ''}`;
      throw new ExternalError('supabase', operation, detail);
    }
    return { value: data as T, httpStatus: 200 };
  });
}

// ---------------------------------------------------------------- threads

export async function findThreadByChatId(chatId: string): Promise<Thread | null> {
  const rows = await q<Thread[]>('threads.selectByChatId', () =>
    client.from('threads').select('*').eq('customer_chat_id', chatId).limit(1),
  );
  return rows?.[0] ?? null;
}

export async function findThreadByTopicId(topicId: number): Promise<Thread | null> {
  const rows = await q<Thread[]>('threads.selectByTopicId', () =>
    client.from('threads').select('*').eq('topic_id', topicId).limit(1),
  );
  return rows?.[0] ?? null;
}

export async function getThread(id: string): Promise<Thread | null> {
  const rows = await q<Thread[]>('threads.selectById', () => client.from('threads').select('*').eq('id', id).limit(1));
  return rows?.[0] ?? null;
}

export async function listThreads(limit = 200): Promise<Thread[]> {
  return (
    (await q<Thread[]>('threads.list', () =>
      client.from('threads').select('*').order('last_message_at', { ascending: false, nullsFirst: false }).limit(limit),
    )) ?? []
  );
}

export async function createThread(input: {
  customer_chat_id: string;
  customer_name: string;
  customer_username: string | null;
  topic_id: number | null;
}): Promise<Thread> {
  const rows = await q<Thread[]>('threads.insert', () => client.from('threads').insert(input as never).select('*'));
  const thread = rows![0];
  bus.publish({ type: 'thread.updated', thread });
  return thread;
}

export async function updateThread(id: string, patch: Partial<Thread>): Promise<Thread> {
  const rows = await q<Thread[]>('threads.update', () =>
    client.from('threads').update(patch as never).eq('id', id).select('*'),
  );
  const thread = rows![0];
  bus.publish({ type: 'thread.updated', thread });
  return thread;
}

export async function setThreadMode(id: string, mode: ThreadMode): Promise<Thread> {
  return updateThread(id, { mode });
}

// --------------------------------------------------------------- messages

export async function insertMessage(input: {
  thread_id: string;
  role: MessageRole;
  text: string;
  tg_message_id?: number | null;
  run_id?: string | null;
  meta?: Record<string, unknown>;
}): Promise<Message> {
  const rows = await q<Message[]>('messages.insert', () =>
    client
      .from('messages')
      .insert({
        thread_id: input.thread_id,
        role: input.role,
        text: input.text,
        tg_message_id: input.tg_message_id ?? null,
        run_id: input.run_id ?? null,
        meta: input.meta ?? {},
      } as never)
      .select('*'),
  );
  const message = rows![0];
  bus.publish({ type: 'message.created', message });
  return message;
}

export async function listMessages(threadId: string, limit = 200): Promise<Message[]> {
  const rows =
    (await q<Message[]>('messages.list', () =>
      client.from('messages').select('*').eq('thread_id', threadId).order('created_at', { ascending: false }).limit(limit),
    )) ?? [];
  return rows.reverse();
}

// ------------------------------------------------------------------- runs

export async function insertRun(input: {
  thread_id: string;
  generation: number;
  input_message_ids: number[];
  input_texts: string[];
  llm_model: string;
}): Promise<Run> {
  const rows = await q<Run[]>('runs.insert', () =>
    client
      .from('runs')
      .insert({
        thread_id: input.thread_id,
        generation: input.generation,
        status: 'queued' satisfies RunStatus,
        input_message_ids: input.input_message_ids,
        input_texts: input.input_texts,
        batch_size: input.input_texts.length,
        llm_model: input.llm_model,
      } as never)
      .select('*'),
  );
  const run = rows![0];
  bus.publish({ type: 'run.updated', run });
  return run;
}

export async function updateRun(id: string, patch: Partial<Run>): Promise<Run> {
  const rows = await q<Run[]>('runs.update', () => client.from('runs').update(patch as never).eq('id', id).select('*'));
  const run = rows![0];
  bus.publish({ type: 'run.updated', run });
  return run;
}

export async function listRuns(limit = 60, threadId?: string): Promise<Run[]> {
  return (
    (await q<Run[]>('runs.list', () => {
      let query = client.from('runs').select('*').order('queued_at', { ascending: false }).limit(limit);
      if (threadId) query = query.eq('thread_id', threadId);
      return query;
    })) ?? []
  );
}

export async function listRunEvents(runIds: string[]): Promise<RunEvent[]> {
  if (!runIds.length) return [];
  return (
    (await q<RunEvent[]>('run_events.list', () =>
      client.from('run_events').select('*').in('run_id', runIds).order('seq', { ascending: true }).limit(2000),
    )) ?? []
  );
}

export async function insertRunEvent(event: Omit<RunEvent, 'id'>): Promise<void> {
  bus.publish({ type: 'run.event', event });
  await q<unknown>('run_events.insert', () => client.from('run_events').insert(event as never)).catch(() => {
    /* ошибка уже опубликована в шину */
  });
}

// ------------------------------------------------------------- escalations

export async function insertEscalation(input: {
  thread_id: string;
  run_id: string | null;
  reason: string;
  summary: string;
  context?: Record<string, unknown>;
}): Promise<Escalation> {
  const rows = await q<Escalation[]>('escalations.insert', () =>
    client
      .from('escalations')
      .insert({ ...input, context: input.context ?? {} } as never)
      .select('*'),
  );
  const escalation = rows![0];
  bus.publish({ type: 'escalation.updated', escalation });
  return escalation;
}

export async function listEscalations(limit = 200): Promise<Escalation[]> {
  return (
    (await q<Escalation[]>('escalations.list', () =>
      client.from('escalations').select('*').order('created_at', { ascending: false }).limit(limit),
    )) ?? []
  );
}

export async function updateEscalation(id: string, status: EscalationStatus, resolvedBy: string): Promise<Escalation> {
  const patch: Record<string, unknown> = { status, resolved_by: resolvedBy };
  patch.resolved_at = status === 'done' ? new Date().toISOString() : null;
  const rows = await q<Escalation[]>('escalations.update', () =>
    client.from('escalations').update(patch as never).eq('id', id).select('*'),
  );
  const escalation = rows![0];
  bus.publish({ type: 'escalation.updated', escalation });
  return escalation;
}

// ---------------------------------------------------------- external log

export async function listExternalEvents(limit = 200, onlyErrors = false): Promise<ExternalEvent[]> {
  return (
    (await q<ExternalEvent[]>('external_events.list', () => {
      let query = client.from('external_events').select('*').order('created_at', { ascending: false }).limit(limit);
      if (onlyErrors) query = query.eq('status', 'error');
      return query;
    })) ?? []
  );
}

// -------------------------------------------------------------- settings

/** Значение из app_settings; null, если ключа нет */
export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  const rows = await q<{ key: string; value: T }[]>('app_settings.get', () =>
    client.from('app_settings').select('*').eq('key', key).limit(1),
  );
  return rows?.[0]?.value ?? null;
}

/** Upsert настройки — используется переключателем провайдера LLM */
export async function setSetting(key: string, value: unknown): Promise<void> {
  await q<unknown>('app_settings.set', () =>
    client
      .from('app_settings')
      .upsert({ key, value, updated_at: new Date().toISOString() } as never, { onConflict: 'key' }),
  );
}

/** Быстрая проверка доступности БД для /healthz и индикатора в UI */
export async function pingDb(): Promise<void> {
  await q<unknown>('healthcheck', () => client.from('app_settings').select('key').limit(1));
}
