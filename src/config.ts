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

function numList(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!raw.trim()) return [];
  return raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * SUPABASE_URL должен быть origin проекта. Частая ошибка — вставить туда полный
 * REST-эндпоинт (".../rest/v1/"): клиент допишет свой путь, и PostgREST ответит
 * PGRST125 "Invalid path specified in request URL". Приводим значение к origin.
 */
export const supabaseUrlNotes: string[] = [];
function supabaseOrigin(): string {
  const raw = required('SUPABASE_URL');
  if (!raw) return '';
  let url = raw.trim();
  const before = url;
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/rest\/v1$/i, '');
  url = url.replace(/\/+$/, '');
  if (url !== before) {
    supabaseUrlNotes.push(
      `SUPABASE_URL приведён к origin: убран лишний путь/слэш («${before}» → «${url}»). ` +
        'В переменной должен быть только адрес проекта, например https://abcdef.supabase.co',
    );
  }
  return url;
}

export const config = {
  port: num('PORT', 8080),
  publicBaseUrl: optional('PUBLIC_BASE_URL'),

  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    managerChatId: required('TELEGRAM_MANAGER_CHAT_ID'),
    webhookSecret: required('TELEGRAM_WEBHOOK_SECRET'),
    apiBase: optional('TELEGRAM_API_BASE', 'https://api.telegram.org'),
    /**
     * Топики чата менеджеров, которые бот не обрабатывает.
     * По умолчанию 1 и 2: топик 1 — служебный General супергруппы, туда
     * попадают системные сообщения и общая переписка, не относящаяся к клиентам.
     * Пустое значение переменной отключает фильтр.
     */
    ignoredTopicIds: numList('TELEGRAM_IGNORED_TOPIC_IDS', [1, 2]),
  },

  supabase: {
    url: supabaseOrigin(),
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
