/** Общий контракт провайдеров LLM: Gemini и OpenAI-совместимый API Bazaar. */

export type LlmProviderId = 'gemini' | 'apibazaar';

/** Ход диалога с моделью. 'model' — ответ самой модели (для переспроса JSON). */
export interface Turn {
  role: 'user' | 'model';
  text: string;
}

export interface GenerateCtx {
  threadId?: string | null;
  runId?: string | null;
  signal?: AbortSignal;
  attempt?: number;
}

export interface LlmCallResult {
  text: string;
  finishReason: string | null;
  usage: Record<string, unknown> | null;
}

export interface ProviderReadiness {
  ok: boolean;
  /** какие переменные окружения не заданы */
  missing: string[];
}

export interface LlmProvider {
  id: LlmProviderId;
  label: string;
  /** имя модели для журнала и UI */
  model(): string;
  /** заданы ли все нужные секреты */
  readiness(): ProviderReadiness;
  generate(turns: Turn[], ctx: GenerateCtx): Promise<LlmCallResult>;
}

/** Как прогон подписывается в runs.llm_model */
export function describeModel(providerId: LlmProviderId, model: string): string {
  return `${providerId}:${model}`;
}
