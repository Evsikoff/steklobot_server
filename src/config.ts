import 'dotenv/config';

const missing: string[] = [];

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    missing.push(name);
    return '';
  }
  return value.trim();
}

function optional(name: string, fallback = ''): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: num('PORT', 8080),
  publicBaseUrl: optional('PUBLIC_BASE_URL'),

  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    managerChatId: required('TELEGRAM_MANAGER_CHAT_ID'),
    webhookSecret: required('TELEGRAM_WEBHOOK_SECRET'),
    apiBase: optional('TELEGRAM_API_BASE', 'https://api.telegram.org'),
  },

  supabase: {
    url: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    timeoutMs: num('SUPABASE_TIMEOUT_MS', 15_000),
  },

  llm: {
    apiKey: required('GEMINI_API_KEY'),
    model: optional('GEMINI_MODEL', 'gemini-3.7-flash'),
    apiBase: optional('GEMINI_API_BASE', 'https://generativelanguage.googleapis.com'),
    temperature: num('LLM_TEMPERATURE', 0.1),
    maxOutputTokens: num('LLM_MAX_OUTPUT_TOKENS', 1024),
    timeoutMs: num('LLM_TIMEOUT_MS', 45_000),
    /** сколько раз просим модель переделать невалидный JSON */
    maxJsonRetries: num('LLM_MAX_JSON_RETRIES', 2),
  },

  orchestrator: {
    /** окно склейки: ждём столько мс после последнего сообщения, прежде чем звать LLM */
    debounceMs: num('ORCHESTRATOR_DEBOUNCE_MS', 1200),
    /** максимум сообщений клиента, склеиваемых в один прогон */
    maxBatch: num('ORCHESTRATOR_MAX_BATCH', 10),
    /** сколько последних сообщений отдаём модели как историю */
    historyLimit: num('HISTORY_LIMIT', 20),
  },

  priceList: {
    csvUrl: required('PRICE_LIST_CSV_URL'),
    cacheTtlMs: num('PRICE_LIST_CACHE_TTL_MS', 120_000),
    timeoutMs: num('PRICE_LIST_TIMEOUT_MS', 15_000),
  },

  ui: {
    password: required('ADMIN_PASSWORD'),
    sessionSecret: required('SESSION_SECRET'),
    sessionTtlMs: num('SESSION_TTL_MS', 7 * 24 * 60 * 60 * 1000),
  },

  logRetentionEvents: num('LOG_RING_SIZE', 300),
};

export function assertConfig(): void {
  if (missing.length) {
    throw new Error(
      'Не заданы обязательные переменные окружения: ' +
        missing.join(', ') +
        '. См. README.md → «Секреты Northflank».',
    );
  }
}

export type Config = typeof config;
