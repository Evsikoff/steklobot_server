import { config } from '../config.js';
import { ExternalError, httpJson } from './external.js';

/**
 * Распознавание фото автомобиля обычной мультимодальной Gemini (GEMINI_MODEL).
 *
 * Отдельный вызов, а не картинка в основном прогоне: так подбор стекла остаётся
 * ровно тем же, что и для текста (прайс, склейка сообщений, переспрос JSON),
 * и продолжает работать, когда ответы генерит API Bazaar — он картинки не умеет.
 * Результат подмешивается в сообщение клиента блоком «[Фото: …]».
 */

const VISION_PROMPT = `Ты определяешь автомобиль по фотографии для службы замены автостёкол.

Смотри на кузов, решётку, фары, фонари, эмблему, форму стоек и любые видимые надписи.
Год по фото точно не определяется — указывай диапазон лет поколения, а не конкретный год.
Ничего не выдумывай: если марку или модель не видно, ставь null и понижай confidence.

Верни СТРОГО один JSON-объект без markdown и пояснений:
{"isCar":true,"make":"Toyota","model":"Camry","generation":"XV50","yearFrom":2011,"yearTo":2017,"bodyType":"седан","glass":"лобовое","damage":"трещина справа внизу","confidence":"high","notes":""}

Поля:
- isCar — есть ли на фото автомобиль (false для всего остального);
- make, model — латиницей, как в каталогах (Toyota, Hyundai, Volkswagen);
- generation — обозначение поколения, если уверен, иначе null;
- yearFrom, yearTo — годы выпуска поколения числами, иначе null;
- bodyType — по-русски: седан, хэтчбек, универсал, кроссовер, минивэн, пикап, купе;
- glass — какое стекло в фокусе кадра или повреждено: "лобовое", "заднее", "боковое"; null, если не понять;
- damage — краткое описание повреждения по-русски, либо null;
- confidence — "high", "medium" или "low": насколько уверен в марке и модели;
- notes — одна короткая фраза по-русски о том, что ещё видно полезного, либо "".`;

export interface CarPhoto {
  isCar: boolean;
  make: string | null;
  model: string | null;
  generation: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  bodyType: string | null;
  glass: string | null;
  damage: string | null;
  confidence: 'high' | 'medium' | 'low';
  notes: string | null;
}

export interface VisionCtx {
  threadId?: string | null;
  runId?: string | null;
}

export function visionModel(): string {
  return config.vision.model.replace(/^models\//, '');
}

export function visionReadiness(): { ok: boolean; reason: string | null } {
  if (!config.vision.enabled) return { ok: false, reason: 'распознавание фото отключено (VISION_ENABLED=0)' };
  if (!config.llm.apiKey) return { ok: false, reason: 'не задан GEMINI_API_KEY' };
  return { ok: true, reason: null };
}

/** Gemini иногда оборачивает JSON в ```-блок, несмотря на responseMimeType */
function parseJson(raw: string): Record<string, unknown> {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('в ответе нет JSON-объекта');
  return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
}

function str(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.toLowerCase() !== 'null' ? text : null;
}

function year(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 1950 && parsed <= 2100 ? parsed : null;
}

function normalize(raw: Record<string, unknown>): CarPhoto {
  const confidence = str(raw.confidence)?.toLowerCase();
  return {
    isCar: raw.isCar !== false,
    make: str(raw.make),
    model: str(raw.model),
    generation: str(raw.generation),
    yearFrom: year(raw.yearFrom),
    yearTo: year(raw.yearTo),
    bodyType: str(raw.bodyType),
    glass: str(raw.glass),
    damage: str(raw.damage),
    confidence: confidence === 'high' || confidence === 'low' ? confidence : 'medium',
    notes: str(raw.notes),
  };
}

/** Фото → структурированное описание автомобиля */
export async function describeCarPhoto(image: Uint8Array, mimeType: string, ctx: VisionCtx = {}): Promise<CarPhoto> {
  const ready = visionReadiness();
  if (!ready.ok) throw new ExternalError('gemini', 'vision', `Распознавание фото недоступно: ${ready.reason}`);

  const model = visionModel();
  const operation = `vision:${model}`;
  const url = `${config.llm.apiBase}/v1beta/models/${model}:generateContent`;

  const payload = {
    systemInstruction: { parts: [{ text: VISION_PROMPT }] },
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: Buffer.from(image).toString('base64') } },
          { text: 'Определи автомобиль на фото и верни JSON по заданной схеме.' },
        ],
      },
    ],
    generationConfig: { temperature: 0, maxOutputTokens: 512, responseMimeType: 'application/json' },
  };

  const res = await httpJson(
    {
      service: 'gemini',
      operation,
      threadId: ctx.threadId,
      runId: ctx.runId,
      request: { model, mimeType, bytes: image.length },
    },
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.llm.apiKey },
      body: JSON.stringify(payload),
      timeoutMs: config.vision.timeoutMs,
    },
    { retries: 1, retryDelayMs: 800 },
  );

  const body = res.body as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };

  if (body.promptFeedback?.blockReason) {
    throw new ExternalError('gemini', operation, `Фото заблокировано моделью: ${body.promptFeedback.blockReason}`, res.status, body);
  }

  const candidate = body.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join('').trim();
  if (!text) {
    throw new ExternalError(
      'gemini',
      operation,
      `Модель вернула пустой ответ (finishReason=${candidate?.finishReason ?? 'unknown'})`,
      res.status,
      body,
    );
  }

  try {
    return normalize(parseJson(text));
  } catch (err) {
    throw new ExternalError('gemini', operation, `Не разобрать ответ модели: ${(err as Error).message}`, res.status, {
      raw: text.slice(0, 1000),
    });
  }
}

const CONFIDENCE_LABEL: Record<CarPhoto['confidence'], string> = {
  high: 'высокая',
  medium: 'средняя',
  low: 'низкая',
};

/**
 * Описание → строка, которая уходит в пайплайн как часть сообщения клиента.
 * Формат «[Фото: …]» отдельно оговорён в системном промпте: модель знает,
 * что это распознавание, а не слова клиента, и год всё равно уточняет.
 */
export function photoToPromptText(photo: CarPhoto): string {
  if (!photo.isCar) return '[Фото: автомобиль на снимке не распознан.]';

  const parts: string[] = [];
  const car = [photo.make, photo.model].filter(Boolean).join(' ');
  parts.push(car ? `распознан ${car}` : 'марку и модель определить не удалось');
  if (photo.generation) parts.push(`поколение ${photo.generation}`);
  if (photo.yearFrom && photo.yearTo) parts.push(`годы выпуска поколения ${photo.yearFrom}–${photo.yearTo}`);
  else if (photo.yearFrom) parts.push(`выпускается с ${photo.yearFrom}`);
  if (photo.bodyType) parts.push(`кузов ${photo.bodyType}`);
  if (photo.glass) parts.push(`в кадре ${photo.glass} стекло`);
  if (photo.damage) parts.push(`повреждение: ${photo.damage}`);
  if (photo.notes) parts.push(photo.notes);
  parts.push(`уверенность распознавания ${CONFIDENCE_LABEL[photo.confidence]}`);

  return `[Фото: ${parts.join(', ')}. Точный год выпуска по фото неизвестен.]`;
}

/** Короткая строка для дубля в топик менеджеров */
export function photoSummary(photo: CarPhoto): string {
  if (!photo.isCar) return 'автомобиль не распознан';
  const car = [photo.make, photo.model].filter(Boolean).join(' ') || 'марка не определена';
  const years = photo.yearFrom && photo.yearTo ? ` ${photo.yearFrom}–${photo.yearTo}` : '';
  return `${car}${years}, уверенность ${CONFIDENCE_LABEL[photo.confidence]}`;
}
