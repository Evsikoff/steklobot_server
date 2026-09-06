import { config } from '../../config.js';
import { ExternalError, httpJson } from '../external.js';
import { SYSTEM_PROMPT } from './prompt.js';
import type { GenerateCtx, LlmCallResult, LlmProvider, ProviderReadiness, Turn } from './provider.js';

/**
 * OpenAI-совместимый провайдер (API Bazaar).
 * Эквивалент вызова:
 *   client = OpenAI(api_key=API_BAZAAR_KEY, base_url=API_BAZAAR_URL)
 *   client.chat.completions.create(model=API_BAZAAR_MODEL, messages=[...])
 */

/**
 * Собирает адрес эндпоинта. SDK дописывает /chat/completions к base_url,
 * поэтому принимаем и "https://api.apibazaar.shop/v1", и полный путь —
 * лишние слэши и повторный /chat/completions не ломают запрос.
 */
export function completionsEndpoint(base: string): string {
  const url = base.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(url)) return url;
  return `${url}/chat/completions`;
}

function readiness(): ProviderReadiness {
  const missing: string[] = [];
  if (!config.apiBazaar.url) missing.push('API_BAZAAR_URL');
  if (!config.apiBazaar.key) missing.push('API_BAZAAR_KEY');
  if (!config.apiBazaar.model) missing.push('API_BAZAAR_MODEL');
  return { ok: missing.length === 0, missing };
}

/** Роли у OpenAI другие: model → assistant, системный промпт отдельным сообщением */
function toMessages(turns: Turn[]) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...turns.map((turn) => ({ role: turn.role === 'model' ? 'assistant' : 'user', content: turn.text })),
  ];
}

export const apiBazaarProvider: LlmProvider = {
  id: 'apibazaar',
  label: 'API Bazaar',
  model: () => config.apiBazaar.model || '(модель не задана)',
  readiness,

  async generate(turns: Turn[], ctx: GenerateCtx): Promise<LlmCallResult> {
    const ready = readiness();
    if (!ready.ok) {
      throw new ExternalError(
        'apibazaar',
        'chatCompletions',
        `Не заданы переменные окружения: ${ready.missing.join(', ')}`,
      );
    }

    const model = config.apiBazaar.model;
    const payload: Record<string, unknown> = {
      model,
      messages: toMessages(turns),
      temperature: config.llm.temperature,
      max_tokens: config.llm.maxOutputTokens,
    };
    // не все модели за прокси принимают response_format — включается флагом
    if (config.apiBazaar.jsonMode) payload.response_format = { type: 'json_object' };

    const res = await httpJson(
      {
        service: 'apibazaar',
        operation: `chatCompletions:${model}`,
        threadId: ctx.threadId,
        runId: ctx.runId,
        request: { model, messages: turns.length + 1, lastTurnPreview: turns[turns.length - 1]?.text.slice(0, 500) },
      },
      completionsEndpoint(config.apiBazaar.url),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiBazaar.key}`,
        },
        body: JSON.stringify(payload),
        timeoutMs: config.llm.timeoutMs,
        signal: ctx.signal,
      },
      { retries: 2, retryDelayMs: 800 },
    );

    const body = res.body as {
      choices?: { message?: { content?: string | null }; finish_reason?: string }[];
      usage?: Record<string, unknown>;
      error?: { message?: string };
    };

    if (body.error?.message) {
      throw new ExternalError('apibazaar', 'chatCompletions', `Ошибка провайдера: ${body.error.message}`, res.status, body);
    }

    const choice = body.choices?.[0];
    const text = (choice?.message?.content ?? '').trim();

    if (!text) {
      throw new ExternalError(
        'apibazaar',
        'chatCompletions',
        `Модель вернула пустой ответ (finish_reason=${choice?.finish_reason ?? 'unknown'})`,
        res.status,
        body,
      );
    }

    return { text, finishReason: choice?.finish_reason ?? null, usage: body.usage ?? null };
  },
};
