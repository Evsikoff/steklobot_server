import { bus } from '../bus.js';
import { log, errorMessage } from '../logger.js';
import type { ExternalEvent } from '../types.js';

/**
 * Единая точка учёта ВСЕХ внешних взаимодействий.
 * Любой вызов Telegram / Gemini / прайса / Supabase проходит здесь,
 * поэтому UI всегда видит и успехи, и ошибки, и коды ответов.
 */

export class ExternalError extends Error {
  constructor(
    public readonly service: ExternalEvent['service'],
    public readonly operation: string,
    message: string,
    public readonly httpStatus: number | null = null,
    public readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'ExternalError';
  }
}

/** записывается в БД отдельным модулем, чтобы не тащить сюда зависимость от supabase */
type Sink = (event: ExternalEvent) => void;
let sink: Sink = () => {};
export function setExternalEventSink(next: Sink): void {
  sink = next;
}

export interface TrackContext {
  service: ExternalEvent['service'];
  operation: string;
  threadId?: string | null;
  runId?: string | null;
  request?: unknown;
  attempt?: number;
  /** false — не писать в Supabase (используется для самих вызовов Supabase, чтобы не зациклиться) */
  persist?: boolean;
}

export interface TrackResult<T> {
  value: T;
  httpStatus: number | null;
  response?: unknown;
}

function emit(event: ExternalEvent, persist: boolean) {
  bus.publish({ type: 'external.event', event });
  if (persist) sink(event);
  if (event.status === 'error') {
    log.error(`external:${event.service}:${event.operation}`, { error: event.error, http: event.http_status });
  }
}

/**
 * Оборачивает вызов внешнего сервиса: меряет время, ловит ошибку,
 * публикует событие в шину и (опционально) в Supabase.
 */
export async function tracked<T>(ctx: TrackContext, fn: () => Promise<TrackResult<T>>): Promise<T> {
  const startedAt = Date.now();
  const persist = ctx.persist !== false;
  try {
    const result = await fn();
    emit(
      {
        service: ctx.service,
        operation: ctx.operation,
        status: 'ok',
        http_status: result.httpStatus,
        duration_ms: Date.now() - startedAt,
        attempt: ctx.attempt ?? 1,
        thread_id: ctx.threadId ?? null,
        run_id: ctx.runId ?? null,
        request: truncate(ctx.request),
        response: truncate(result.response),
        error: null,
        created_at: new Date().toISOString(),
      },
      persist,
    );
    return result.value;
  } catch (err) {
    const httpStatus = err instanceof ExternalError ? err.httpStatus : null;
    emit(
      {
        service: ctx.service,
        operation: ctx.operation,
        status: 'error',
        http_status: httpStatus,
        duration_ms: Date.now() - startedAt,
        attempt: ctx.attempt ?? 1,
        thread_id: ctx.threadId ?? null,
        run_id: ctx.runId ?? null,
        request: truncate(ctx.request),
        response: err instanceof ExternalError ? truncate(err.details) : null,
        error: errorMessage(err),
        created_at: new Date().toISOString(),
      },
      persist,
    );
    throw err;
  }
}

/** HTTP-вызов с ретраями на сетевые ошибки и 5xx/429 */
export async function httpJson(
  ctx: Omit<TrackContext, 'attempt'>,
  url: string,
  init: RequestInit & { timeoutMs?: number },
  opts: { retries?: number; retryDelayMs?: number } = {},
): Promise<{ status: number; body: unknown; text: string; headers: Headers }> {
  const retries = opts.retries ?? 2;
  const retryDelayMs = opts.retryDelayMs ?? 700;
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await tracked({ ...ctx, attempt }, async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 20_000);
        // объединяем внешний signal (отмена прогона) с таймаутом
        const external = init.signal;
        const onAbort = () => controller.abort();
        external?.addEventListener('abort', onAbort, { once: true });
        try {
          const res = await fetch(url, { ...init, signal: controller.signal });
          const text = await res.text();
          let body: unknown = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = text;
          }
          if (!res.ok) {
            throw new ExternalError(ctx.service, ctx.operation, describeHttpError(res.status, body, text), res.status, body);
          }
          return { value: { status: res.status, body, text, headers: res.headers }, httpStatus: res.status, response: body };
        } catch (err) {
          if (err instanceof ExternalError) throw err;
          if ((err as Error)?.name === 'AbortError') {
            if (external?.aborted) {
              throw new ExternalError(ctx.service, ctx.operation, 'Запрос отменён (прогон заменён новым)', null, null);
            }
            throw new ExternalError(ctx.service, ctx.operation, `Таймаут ${init.timeoutMs ?? 20_000} мс`, null, null);
          }
          throw new ExternalError(ctx.service, ctx.operation, `Сетевая ошибка: ${errorMessage(err)}`, null, null);
        } finally {
          clearTimeout(timer);
          external?.removeEventListener('abort', onAbort);
        }
      });
    } catch (err) {
      lastError = err;
      const status = err instanceof ExternalError ? err.httpStatus : null;
      const retriable = status === null || status === 429 || (status >= 500 && status <= 599);
      const aborted = init.signal?.aborted === true;
      if (!retriable || aborted || attempt > retries) break;
      await sleep(retryDelayMs * attempt);
    }
  }
  throw lastError;
}

function describeHttpError(status: number, body: unknown, text: string): string {
  const asObj = body as Record<string, unknown> | null;
  const description =
    (asObj && typeof asObj.description === 'string' && asObj.description) ||
    (asObj && typeof asObj.message === 'string' && asObj.message) ||
    (asObj && typeof (asObj.error as Record<string, unknown>)?.message === 'string'
      ? ((asObj.error as Record<string, unknown>).message as string)
      : '') ||
    summarizeBody(text);
  return `HTTP ${status}${description ? `: ${description}` : ''}`;
}

/** HTML-страницы ошибок превращаем в короткую подсказку, а не в стену тегов */
export function summarizeBody(text: string, limit = 200): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (/^<(!doctype|html|\?xml)/i.test(trimmed)) {
    const title = trimmed.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
    return `сервер вернул HTML-страницу${title ? ` «${title}»` : ''} вместо данных — проверьте URL и права доступа`;
  }
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function truncate(value: unknown, limit = 4000): unknown {
  if (value == null) return null;
  try {
    const json = JSON.stringify(value);
    if (json.length <= limit) return value;
    return { truncated: true, preview: json.slice(0, limit) };
  } catch {
    return { unserializable: true };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
