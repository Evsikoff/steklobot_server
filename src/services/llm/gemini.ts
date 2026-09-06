import { config } from '../../config.js';
import { ExternalError, httpJson } from '../external.js';
import { SYSTEM_PROMPT } from './prompt.js';
import type { GenerateCtx, LlmCallResult, LlmProvider, ProviderReadiness, Turn } from './provider.js';

function readiness(): ProviderReadiness {
  return config.llm.apiKey ? { ok: true, missing: [] } : { ok: false, missing: ['GEMINI_API_KEY'] };
}

/**
 * Один вызов Gemini generateContent.
 * `turns` — вся цепочка: исходный запрос, ответ модели, просьба переделать JSON и т.д.
 */
async function generate(turns: Turn[], ctx: GenerateCtx): Promise<LlmCallResult> {
  const model = config.llm.model.replace(/^models\//, '');
  const url = `${config.llm.apiBase}/v1beta/models/${model}:generateContent`;

  const payload = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: turns.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
    generationConfig: {
      temperature: config.llm.temperature,
      maxOutputTokens: config.llm.maxOutputTokens,
      responseMimeType: 'application/json',
    },
  };

  const res = await httpJson(
    {
      service: 'gemini',
      operation: `generateContent:${model}`,
      threadId: ctx.threadId,
      runId: ctx.runId,
      request: { model, turns: turns.length, lastTurnPreview: turns[turns.length - 1]?.text.slice(0, 500) },
    },
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.llm.apiKey },
      body: JSON.stringify(payload),
      timeoutMs: config.llm.timeoutMs,
      signal: ctx.signal,
    },
    { retries: 2, retryDelayMs: 800 },
  );

  const body = res.body as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
    usageMetadata?: Record<string, unknown>;
  };

  if (body.promptFeedback?.blockReason) {
    throw new ExternalError('gemini', 'generateContent', `Запрос заблокирован моделью: ${body.promptFeedback.blockReason}`, res.status, body);
  }

  const candidate = body.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join('').trim();

  if (!text) {
    throw new ExternalError(
      'gemini',
      'generateContent',
      `Модель вернула пустой ответ (finishReason=${candidate?.finishReason ?? 'unknown'})`,
      res.status,
      body,
    );
  }

  return { text, finishReason: candidate?.finishReason ?? null, usage: body.usageMetadata ?? null };
}

export const geminiProvider: LlmProvider = {
  id: 'gemini',
  label: 'Gemini',
  model: () => config.llm.model.replace(/^models\//, ''),
  readiness,
  generate,
};
