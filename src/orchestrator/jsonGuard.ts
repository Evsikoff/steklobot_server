import { z } from 'zod';
import type { LlmAnswer, PriceSelection } from '../types.js';

const escalateSchema = z
  .object({
    reason: z.string().min(1),
    summary: z.string().default(''),
  })
  .nullable();

const answerSchema = z.object({
  reply: z.string().default(''),
  lookupStatus: z.enum(['not_requested', 'need_details', 'found', 'found_multiple', 'not_found']),
  matchedPriceIds: z.array(z.union([z.string(), z.number()])).default([]),
  // значение нормализуем сами: неожиданное слово не должно ронять весь ответ
  selection: z.union([z.string(), z.null()]).optional(),
  escalate: escalateSchema.default(null),
});

/** "cheapest", "Cheapest in stock", "самый дешёвый" → cheapest; всё прочее → all */
function normalizeSelection(raw: unknown): PriceSelection {
  const value = String(raw ?? '').toLowerCase();
  return value.includes('cheap') || value.includes('дешев') || value.includes('дешёв') ? 'cheapest' : 'all';
}

export type ValidationResult =
  | { ok: true; value: LlmAnswer }
  | { ok: false; problem: string };

/** Снимаем ```json ... ``` и вытаскиваем первый сбалансированный JSON-объект */
function extractJson(raw: string): string | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Проверка валидности JSON от LLM.
 * Возвращает либо готовый ответ, либо человекочитаемую причину — её же
 * отправляем модели с просьбой переделать.
 */
export function validateLlmJson(raw: string): ValidationResult {
  const candidate = extractJson(raw);
  if (!candidate) {
    return { ok: false, problem: 'в ответе нет JSON-объекта (не найдены парные фигурные скобки)' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return { ok: false, problem: `JSON.parse не смог разобрать ответ: ${(err as Error).message}` };
  }

  // допускаем устаревшее поле matchedPriceId (единственное число)
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (!obj.matchedPriceIds && obj.matchedPriceId != null) obj.matchedPriceIds = [obj.matchedPriceId];
  }

  const result = answerSchema.safeParse(parsed);
  if (!result.success) {
    const problem = result.error.issues
      .map((issue) => `поле "${issue.path.join('.') || '(корень)'}": ${issue.message}`)
      .join('; ');
    return { ok: false, problem };
  }

  const ids = [...new Set(result.data.matchedPriceIds.map((id) => String(id)))];
  return {
    ok: true,
    value: {
      reply: result.data.reply.trim(),
      lookupStatus: result.data.lookupStatus,
      matchedPriceIds: ids,
      selection: normalizeSelection(result.data.selection),
      escalate: result.data.escalate,
    },
  };
}
