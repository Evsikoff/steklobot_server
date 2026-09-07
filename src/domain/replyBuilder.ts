import type { Escalate, LlmAnswer, PriceRow } from '../types.js';

const TYPE_NAMES: Record<string, string> = { Front: 'лобовое', Rear: 'заднее', Side: 'боковое' };
/** порядок блоков в ответе, чтобы «лобовое и заднее» всегда шло в одном и том же порядке */
const TYPE_ORDER = ['Front', 'Rear', 'Side'];
const FEATURE_NAMES: Record<string, string> = {
  None: 'без доп. опций',
  'Rain sensor': 'датчик дождя',
  Heating: 'обогрев',
  Camera: 'камера',
  HUD: 'HUD',
  Solar: 'солнцезащитное',
};

/** сколько вариантов одного типа стекла показываем, не спрашивая комплектацию */
const MAX_VARIANTS_PER_TYPE = 5;

const money = (value: number) => Number(value).toLocaleString('ru-RU') + ' ₽';
const typeName = (value: string) => TYPE_NAMES[value] ?? value;
const featureNames = (value: string) =>
  String(value || 'None')
    .split(',')
    .map((item) => FEATURE_NAMES[item.trim()] ?? item.trim())
    .join(', ');

const rowTotal = (row: PriceRow) => Number(row.price_glass) + Number(row.price_work);
const inStock = (row: PriceRow) => String(row.in_stock).toLowerCase() === 'yes';

const plural = (count: number, one: string, few: string, many: string) => {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

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

/** Строки одного типа стекла для одной машины — отдельный блок в ответе */
interface TypeGroup {
  make: string;
  model: string;
  glassType: string;
  rows: PriceRow[];
}

/**
 * Клиент часто спрашивает про несколько стёкол сразу («лобовое и заднее»).
 * Без разбиения по типу все строки печатались под заголовком первой из них,
 * и понять, где какое стекло, было невозможно.
 */
function groupByType(rows: PriceRow[]): TypeGroup[] {
  const groups = new Map<string, TypeGroup>();
  for (const row of rows) {
    const key = `${row.make}|${row.model}|${row.glass_type}`.toLowerCase();
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else groups.set(key, { make: row.make, model: row.model, glassType: row.glass_type, rows: [row] });
  }
  const order = (group: TypeGroup) => {
    const index = TYPE_ORDER.indexOf(group.glassType);
    return index === -1 ? TYPE_ORDER.length : index;
  };
  return [...groups.values()].sort(
    (a, b) => order(a) - order(b) || `${a.make} ${a.model}`.localeCompare(`${b.make} ${b.model}`, 'ru'),
  );
}

/**
 * Запрос «самые дешёвые»: из каждого блока берём самый дешёвый вариант и,
 * если его нет в наличии, ещё и самый дешёвый из имеющихся — иначе клиент
 * получает только отсутствующие позиции и уходит к менеджеру ни с чем.
 * Сортировку и суммы считает сервер: цифры модели тут не участвуют.
 */
function pickCheapest(rows: PriceRow[]): { rows: PriceRow[]; labels: Map<string, string> } {
  const sorted = [...rows].sort((a, b) => rowTotal(a) - rowTotal(b));
  const cheapest = sorted[0];
  const cheapestInStock = sorted.find(inStock);
  const labels = new Map<string, string>([[cheapest.id, 'Самый дешёвый']]);
  if (!cheapestInStock || cheapestInStock.id === cheapest.id) return { rows: [cheapest], labels };
  labels.set(cheapestInStock.id, 'Самый дешёвый в наличии');
  return { rows: [cheapest, cheapestInStock], labels };
}

function renderRow(row: PriceRow, prefix: string): string {
  const availability = inStock(row) ? 'в наличии' : 'нет в наличии';
  return (
    prefix +
    `${row.brand}, ${featureNames(row.features)}, ${row.year_from}–${row.year_to}: ` +
    `стекло ${money(row.price_glass)} + установка ${money(row.price_work)} = ${money(rowTotal(row))}; ${availability}.`
  );
}

/** Текст с ценами: один блок на каждый тип стекла, внутри — варианты */
function renderOffer(groups: TypeGroup[], labels: Map<string, string>): string {
  const first = groups[0];
  const sameCar = groups.every((group) => group.make === first.make && group.model === first.model);
  const rowPrefix = (row: PriceRow, index: number, total: number) => {
    const label = labels.get(row.id);
    if (label) return `${label} — `;
    return total > 1 ? `${index + 1}. ` : '';
  };

  const renderRows = (group: TypeGroup) =>
    group.rows.map((row, index) => renderRow(row, rowPrefix(row, index, group.rows.length)));

  // один тип стекла — марка и тип уходят в шапку, отдельный подзаголовок не нужен
  if (groups.length === 1) {
    const single = first.rows.length;
    const header =
      single === 1
        ? `По прайсу для ${first.make} ${first.model}, ${typeName(first.glassType)} стекло:`
        : `Для ${first.make} ${first.model}, ${typeName(first.glassType)} стекло, нашёл ${single} ${plural(single, 'вариант', 'варианта', 'вариантов')}:`;
    return [header, ...renderRows(first)].join('\n');
  }

  const blocks = groups.map((group) => {
    const car = sameCar ? '' : ` (${group.make} ${group.model})`;
    const header = `${capitalize(typeName(group.glassType))} стекло${car}:`;
    return [header, ...renderRows(group)].join('\n');
  });

  const count = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const heading = sameCar
    ? `Для ${first.make} ${first.model} нашёл ${count} ${plural(count, 'вариант', 'варианта', 'вариантов')}:`
    : `Нашёл ${count} ${plural(count, 'вариант', 'варианта', 'вариантов')}:`;
  return [heading, ...blocks].join('\n\n');
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

    let groups = groupByType(matchedRows);
    const labels = new Map<string, string>();
    if (answer.selection === 'cheapest' && groups.length) {
      groups = groups.map((group) => {
        const picked = pickCheapest(group.rows);
        picked.labels.forEach((label, id) => labels.set(id, label));
        return { ...group, rows: picked.rows };
      });
      matchedRows = groups.flatMap((group) => group.rows);
    }

    if (!matchedRows.length) {
      lookupStatus = 'not_found';
      reply = 'Извините, я не нашёл подходящую цену в прайс-листе. Подключаю менеджера — он уточнит стоимость.';
      escalate = {
        reason: 'price_not_found',
        summary: 'Модель указала несуществующие id строк прайса для запроса: ' + input.incomingText,
      };
    } else if (groups.some((group) => group.rows.length > MAX_VARIANTS_PER_TYPE)) {
      lookupStatus = 'need_details';
      matchedRows = [];
      reply =
        'Нашлось много вариантов. Уточните, пожалуйста, комплектацию стекла: наличие датчика дождя, обогрева, камеры или HUD.';
      escalate = null;
    } else {
      if (escalate && ['price_not_found', 'price_source_unavailable'].includes(escalate.reason)) escalate = null;
      reply = renderOffer(groups, labels);

      // наличие проверяем по каждому типу стекла отдельно: лобовое может быть
      // в наличии, а заднее — нет, и клиенту важно знать, чего именно ждать
      const emptyGroups = groups.filter((group) => !group.rows.some(inStock));
      if (emptyGroups.length && !escalate) {
        const emptyIds = emptyGroups.flatMap((group) => group.rows.map((row) => row.id));
        const emptyTypes = emptyGroups.map((group) => `${typeName(group.glassType)} стекло`).join(', ');
        escalate = {
          reason: 'not_in_stock',
          summary:
            (emptyGroups.length === groups.length
              ? `Все показанные позиции (${emptyIds.join(', ')}) отсутствуют в наличии`
              : `Нет в наличии по типам: ${emptyTypes} — позиции ${emptyIds.join(', ')}`) + '; нужны альтернативы.',
        };
        reply +=
          '\n\n' +
          (emptyGroups.length === groups.length
            ? 'Сейчас эти позиции отмечены как отсутствующие. Подключаю менеджера, чтобы проверить альтернативы.'
            : `Нет в наличии: ${emptyGroups.map((group) => typeName(group.glassType) + ' стекло').join(', ')}. ` +
              'Подключаю менеджера, чтобы проверить альтернативы.');
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
