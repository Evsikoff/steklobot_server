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

function strList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
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

  /** провайдер по умолчанию, если в app_settings ещё ничего не сохранено */
  llmProviderDefault: optional('LLM_PROVIDER', 'gemini'),

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

  /**
   * API Bazaar — OpenAI-совместимый эндпоинт. Переменные необязательные:
   * сервер должен стартовать, даже если используется только Gemini.
   * Проверка заполненности делается в момент переключения провайдера.
   */
  apiBazaar: {
    url: optional('API_BAZAAR_URL'),
    key: optional('API_BAZAAR_KEY'),
    model: optional('API_BAZAAR_MODEL'),
    /** некоторые модели за прокси не поддерживают response_format — по умолчанию не шлём */
    jsonMode: optional('API_BAZAAR_JSON_MODE', '') === '1',
  },

  /**
   * Распознавание голосовых сообщений клиента — Gemini 3.5 Transcribe Live
   * (Live API, WebSocket). Ключ тот же, что и у обычного Gemini: GEMINI_API_KEY.
   * Работает независимо от выбранного провайдера LLM: даже когда ответы генерит
   * API Bazaar, голос расшифровывает Gemini.
   */
  transcribe: {
    enabled: optional('TRANSCRIBE_ENABLED', '1') !== '0',
    model: optional('TRANSCRIBE_MODEL', 'gemini-3.5-transcribe-live'),
    /** хост Live API; отделён от REST, потому что схема другая (wss://) */
    wsBase: optional('GEMINI_WS_BASE', 'wss://generativelanguage.googleapis.com'),
    /** подсказка по языку (BCP-47). Пустое значение — автоопределение модели */
    languageCodes: strList('TRANSCRIBE_LANGUAGE_CODES', ['ru-RU']),
    /** у Live-сессии лимит 10 минут — длиннее не отправляем, сразу зовём менеджера */
    maxDurationSec: num('TRANSCRIBE_MAX_DURATION_SEC', 600),
    /** Bot API отдаёт файлы не больше 20 МБ */
    maxFileBytes: num('TRANSCRIBE_MAX_FILE_BYTES', 20 * 1024 * 1024),
    /** общий бюджет на распознавание одного сообщения */
    timeoutMs: num('TRANSCRIBE_TIMEOUT_MS', 60_000),
    /** пауза между 100-мс кусками аудио; 0 — отдаём файл максимально быстро */
    chunkDelayMs: num('TRANSCRIBE_CHUNK_DELAY_MS', 0),
    /** сколько ждём «хвост» расшифровки после audioStreamEnd, если модель молчит */
    finalizeMs: num('TRANSCRIBE_FINALIZE_MS', 4_000),
    /** укороченное ожидание после turnComplete — вдруг за ним придёт ещё кусок */
    graceMs: num('TRANSCRIBE_GRACE_MS', 1_200),
  },

  /**
   * Распознавание фотографий автомобиля. Тот же ключ и та же модель Gemini,
   * что и для ответов (по умолчанию GEMINI_MODEL) — просто отдельный вызов
   * с картинкой, результат подмешивается в сообщение клиента текстом.
   */
  vision: {
    enabled: optional('VISION_ENABLED', '1') !== '0',
    model: optional('VISION_MODEL', optional('GEMINI_MODEL', 'gemini-3.7-flash')),
    maxFileBytes: num('VISION_MAX_FILE_BYTES', 20 * 1024 * 1024),
    timeoutMs: num('VISION_TIMEOUT_MS', 45_000),
    /**
     * С запасом: у думающих моделей рассуждение тратится из этого же лимита,
     * и на тесном бюджете ответ приходит пустым с finishReason=MAX_TOKENS.
     */
    maxOutputTokens: num('VISION_MAX_OUTPUT_TOKENS', 2048),
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
