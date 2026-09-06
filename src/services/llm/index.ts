import { config } from '../../config.js';
import { log } from '../../logger.js';
import { geminiProvider } from './gemini.js';
import { apiBazaarProvider } from './apiBazaar.js';
import type { LlmProvider, LlmProviderId } from './provider.js';

export * from './provider.js';

const providers: Record<LlmProviderId, LlmProvider> = {
  gemini: geminiProvider,
  apibazaar: apiBazaarProvider,
};

export const PROVIDER_IDS = Object.keys(providers) as LlmProviderId[];

export function isProviderId(value: unknown): value is LlmProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as string[]).includes(value);
}

/** Текущий провайдер держим в памяти; источник правды — app_settings в Supabase. */
let current: LlmProviderId = isProviderId(config.llmProviderDefault) ? config.llmProviderDefault : 'gemini';

export function activeProvider(): LlmProvider {
  return providers[current];
}

export function activeProviderId(): LlmProviderId {
  return current;
}

export function getProvider(id: LlmProviderId): LlmProvider {
  return providers[id];
}

/** Применяет провайдера без записи в БД (используется при загрузке настроек на старте) */
export function applyProvider(id: LlmProviderId): void {
  current = id;
  const ready = providers[id].readiness();
  if (!ready.ok) {
    log.warn(`провайдер ${providers[id].label} выбран, но не настроен: нет ${ready.missing.join(', ')}`);
  }
}

/**
 * Восстановление провайдера из настроек при старте.
 * Если сохранённый провайдер больше не настроен (секреты убрали), откатываемся
 * на любой рабочий: иначе бот сломался бы на каждом сообщении клиента.
 */
export function restoreProvider(saved: unknown): { applied: LlmProviderId; fellBackFrom: LlmProviderId | null } {
  const wanted: LlmProviderId = isProviderId(saved)
    ? saved
    : isProviderId(config.llmProviderDefault)
      ? config.llmProviderDefault
      : 'gemini';

  if (providers[wanted].readiness().ok) {
    applyProvider(wanted);
    return { applied: wanted, fellBackFrom: null };
  }

  const fallback = PROVIDER_IDS.find((id) => providers[id].readiness().ok);
  if (!fallback) {
    applyProvider(wanted);
    log.error('ни один провайдер LLM не настроен — ответы клиентам работать не будут');
    return { applied: wanted, fellBackFrom: null };
  }

  applyProvider(fallback);
  log.error(
    `провайдер ${providers[wanted].label} сохранён в настройках, но не настроен ` +
      `(нет ${providers[wanted].readiness().missing.join(', ')}). Временно используется ${providers[fallback].label}.`,
  );
  return { applied: fallback, fellBackFrom: wanted };
}

/** Состояние всех провайдеров для UI */
export function providersOverview() {
  return PROVIDER_IDS.map((id) => {
    const provider = providers[id];
    const ready = provider.readiness();
    return {
      id,
      label: provider.label,
      model: provider.model(),
      active: id === current,
      configured: ready.ok,
      missing: ready.missing,
    };
  });
}
