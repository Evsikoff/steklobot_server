import type { Escalate, LlmAnswer, PriceRow } from '../types.js';

const TYPE_NAMES: Record<string, string> = { Front: 'лобовое', Rear: 'заднее', Side: 'боковое' };
const FEATURE_NAMES: Record<string, string> = {
  None: 'без доп. опций',
  'Rain sensor': 'датчик дождя',
  Heating: 'обогрев',
  Camera: 'камера',
  HUD: 'HUD',
  Solar: 'солнцезащитное',
};

const money = (value: number) => Number(value).toLocaleString('ru-RU') + ' ₽';
const typeName = (value: string) => TYPE_NAMES[value] ?? value;
const featureNames = (value: string) =>
  String(value || 'None')
    .split(',')
    .map((item) => FEATURE_NAMES[item.trim()] ?? item.trim())
    .join(', ');

/**
 * Тексты, которыми предупреждаем клиента, что дальше отвечает человек.
 * Без них клиент видит только ответ модели (а в ветке с ценами — один прайс)
 * и не понимает, что тред уже переведён в ручной режим и нужно подождать.
 */
const HANDOFF_NOTICES: Record<string, string> = {
  deal_ready: 'Передаю заявку менеджеру — он свяжется с вами здесь, подтвердит наличие и запишет на замену.',
  not_in_stock: 'Подключаю менеджера — он подберёт альтернативы и ответит вам здесь же.',
};
const DEFAULT_HANDOFF_NOTICE = 'Подключаю менеджера — он ответит вам здесь же.';

/** уже сказали про менеджера — второй раз не повторяем */
const mentionsHandoff = (reply: string) => /менеджер/i.test(reply);

function withHandoffNotice(reply: string, escalate: Escalate | null): string {
  if (!escalate || mentionsHandoff(reply)) return reply;
  const notice = HANDOFF_NOTICES[escalate.reason] ?? DEFAULT_HANDOFF_NOTICE;
  return reply ? [reply, notice].join('\n') : notice;
}

export interface ComposeInput {
  answer: LlmAnswer;
  priceRows: PriceRow[];
  priceListAvailable: boolean;
  /** текст(ы) клиента — попадает в summary эскалации */
  incomingText: string;
}

export interface ComposeResult {
  reply: string;
  escalate: Escalate | null;
  lookupStatus: LlmAnswer['lookupStatus'];
  matchedRows: PriceRow[];
  /** режим, в который переводим тред после ответа */
  nextMode: 'ai' | 'human';
}

/**
 * Сборка финального ответа клиенту.
 * Цены НИКОГДА не берутся из текста модели — только из строк прайса
 * по id, которые модель вернула в matchedPriceIds.
 */
export function composeReply(input: ComposeInput): ComposeResult {
  const { answer, priceRows, priceListAvailable } = input;
  let reply = answer.reply.trim();
  let escalate: Escalate | null = answer.escalate;
  let lookupStatus = answer.lookupStatus;
  let matchedRows: PriceRow[] = [];

  if (!priceListAvailable && lookupStatus !== 'not_requested') {
    lookupStatus = 'not_found';
    reply = 'Извините, сейчас не удалось получить актуальный прайс. Подключаю менеджера — он уточнит цену.';
    escalate = { reason: 'price_source_unavailable', summary: 'Не удалось загрузить прайс-лист.' };
  } else if (lookupStatus === 'found' || lookupStatus === 'found_multiple') {
    matchedRows = answer.matchedPriceIds
      .map((id) => priceRows.find((row) => String(row.id) === id))
      .filter((row): row is PriceRow => Boolean(row));

    if (!matchedRows.length) {
      lookupStatus = 'not_found';
      reply = 'Извините, я не нашёл подходящую цену в прайс-листе. Подключаю менеджера — он уточнит стоимость.';
      escalate = {
        reason: 'price_not_found',
        summary: 'Модель указала несуществующие id строк прайса для запроса: ' + input.incomingText,
      };
    } else if (matchedRows.length > 5) {
      lookupStatus = 'need_details';
      matchedRows = [];
      reply =
        'Нашлось много вариантов. Уточните, пожалуйста, комплектацию стекла: наличие датчика дождя, обогрева, камеры или HUD.';
      escalate = null;
    } else {
      if (escalate && ['price_not_found', 'price_source_unavailable'].includes(escalate.reason)) escalate = null;
      const lines = matchedRows.map((row, index) => {
        const total = Number(row.price_glass) + Number(row.price_work);
        const availability = String(row.in_stock).toLowerCase() === 'yes' ? 'в наличии' : 'нет в наличии';
        return (
          (matchedRows.length > 1 ? `${index + 1}. ` : '') +
          `${row.brand}, ${featureNames(row.features)}, ${row.year_from}–${row.year_to}: ` +
          `стекло ${money(row.price_glass)} + установка ${money(row.price_work)} = ${money(total)}; ${availability}.`
        );
      });
      const first = matchedRows[0];
      const heading =
        matchedRows.length > 1
          ? `Для ${first.make} ${first.model}, ${typeName(first.glass_type)} стекло, нашёл ${matchedRows.length} варианта:`
          : `По прайсу для ${first.make} ${first.model}, ${typeName(first.glass_type)} стекло:`;
      reply = heading + '\n' + lines.join('\n');

      const availableCount = matchedRows.filter((row) => String(row.in_stock).toLowerCase() === 'yes').length;
      if (availableCount === 0 && !escalate) {
        escalate = {
          reason: 'not_in_stock',
          summary:
            'Все найденные позиции (' + matchedRows.map((row) => row.id).join(', ') + ') отсутствуют в наличии; нужны альтернативы.',
        };
        reply += '\nСейчас эти позиции отмечены как отсутствующие. Подключаю менеджера, чтобы проверить альтернативы.';
      }
    }
  } else if (lookupStatus === 'not_found') {
    reply = 'Извините, я не нашёл подходящую цену в прайс-листе. Подключаю менеджера — он уточнит стоимость.';
    escalate = escalate ?? { reason: 'price_not_found', summary: 'Цена не найдена для запроса: ' + input.incomingText };
  } else if (lookupStatus === 'need_details' && !reply) {
    reply = 'Уточните, пожалуйста, марку, модель, год автомобиля и какое стекло требуется: лобовое, заднее или боковое?';
  }

  // тред уходит в ручной режим — клиент должен знать, что ждёт менеджера
  reply = withHandoffNotice(reply, escalate);

  if (!reply) reply = 'Чем могу помочь с подбором автостекла?';

  return { reply, escalate, lookupStatus, matchedRows, nextMode: escalate ? 'human' : 'ai' };
}

/** Ответ, когда LLM недоступна или так и не вернула валидный JSON */
export function fallbackReply(problem: string): ComposeResult {
  return {
    reply: 'Извините, сейчас не удалось обработать запрос. Подключаю менеджера — он поможет с подбором и ценой.',
    escalate: { reason: 'ai_unavailable', summary: problem },
    lookupStatus: 'not_requested',
    matchedRows: [],
    nextMode: 'human',
  };
}
