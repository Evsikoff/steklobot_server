import { config } from '../config.js';
import { ExternalError, summarizeBody, tracked } from './external.js';
import { errorMessage } from '../logger.js';
import type { PriceRow } from '../types.js';

interface Cache {
  rows: PriceRow[];
  fetchedAt: number;
}

let cache: Cache | null = null;
let lastError: { message: string; at: string } | null = null;

/** Разбор CSV с кавычками — порт логики из n8n-ноды Prepare Price Context */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function toRows(csv: string): PriceRow[] {
  const parsed = parseCsv(csv);
  const headers = (parsed.shift() ?? []).map((value, index) =>
    index === 0 ? String(value).trim().replace(/^﻿/, '') : String(value).trim(),
  );
  return parsed
    .filter((cells) => cells.some((value) => String(value).trim() !== ''))
    .map((cells) => Object.fromEntries(headers.map((header, index) => [header, String(cells[index] ?? '').trim()])))
    .filter((row) => row.id && row.make && row.model)
    .map((row) => ({
      id: String(row.id),
      make: row.make,
      model: row.model,
      year_from: Number(row.year_from),
      year_to: Number(row.year_to),
      glass_type: row.glass_type,
      features: row.features,
      brand: row.brand,
      price_glass: Number(row.price_glass),
      price_work: Number(row.price_work),
      in_stock: row.in_stock,
    }));
}

export interface PriceListResult {
  available: boolean;
  rows: PriceRow[];
  fromCache: boolean;
  error: string | null;
}

/**
 * Прайс — единственный допустимый источник цен.
 * Если источник недоступен, отдаём последний удачный кэш (помечая это),
 * а если кэша нет — available=false, и прогон эскалируется менеджеру.
 */
export async function loadPriceList(ctx: { threadId?: string | null; runId?: string | null; signal?: AbortSignal } = {}): Promise<PriceListResult> {
  const fresh = cache && Date.now() - cache.fetchedAt < config.priceList.cacheTtlMs;
  if (fresh) return { available: cache!.rows.length > 0, rows: cache!.rows, fromCache: true, error: null };

  try {
    const rows = await tracked(
      { service: 'price_list', operation: 'fetchCsv', threadId: ctx.threadId, runId: ctx.runId, request: { url: config.priceList.csvUrl } },
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.priceList.timeoutMs);
        const onAbort = () => controller.abort();
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
        try {
          const res = await fetch(config.priceList.csvUrl, { signal: controller.signal, redirect: 'follow' });
          const text = await res.text();
          if (!res.ok) {
            throw new ExternalError('price_list', 'fetchCsv', `HTTP ${res.status}: ${summarizeBody(text)}`, res.status);
          }
          const parsed = toRows(text);
          if (!parsed.length) {
            throw new ExternalError('price_list', 'fetchCsv', 'Прайс пустой или изменилась структура колонок', res.status);
          }
          return { value: parsed, httpStatus: res.status, response: { rows: parsed.length } };
        } catch (err) {
          if (err instanceof ExternalError) throw err;
          throw new ExternalError('price_list', 'fetchCsv', errorMessage(err));
        } finally {
          clearTimeout(timer);
          ctx.signal?.removeEventListener('abort', onAbort);
        }
      },
    );
    cache = { rows, fetchedAt: Date.now() };
    lastError = null;
    return { available: true, rows, fromCache: false, error: null };
  } catch (err) {
    lastError = { message: errorMessage(err), at: new Date().toISOString() };
    if (cache) {
      return { available: cache.rows.length > 0, rows: cache.rows, fromCache: true, error: lastError.message };
    }
    return { available: false, rows: [], fromCache: false, error: lastError.message };
  }
}

export function priceListStatus() {
  return {
    cachedRows: cache?.rows.length ?? 0,
    fetchedAt: cache ? new Date(cache.fetchedAt).toISOString() : null,
    lastError,
  };
}

export function invalidatePriceCache(): void {
  cache = null;
}
