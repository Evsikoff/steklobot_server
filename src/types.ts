export type ThreadMode = 'ai' | 'human';
export type ThreadStatus = 'open' | 'closed';
export type MessageRole = 'customer' | 'assistant' | 'manager' | 'system';
export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'superseded' | 'cancelled';
export type EscalationStatus = 'new' | 'in_progress' | 'done';
export type ExternalStatus = 'ok' | 'error';

export interface Thread {
  id: string;
  customer_chat_id: string;
  customer_name: string;
  customer_username: string | null;
  topic_id: number | null;
  mode: ThreadMode;
  status: ThreadStatus;
  last_message_at: string | null;
  last_message_text: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: number;
  thread_id: string;
  role: MessageRole;
  text: string;
  tg_message_id: number | null;
  run_id: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface Escalate {
  reason: string;
  summary: string;
}

export interface Run {
  id: string;
  thread_id: string;
  generation: number;
  status: RunStatus;
  input_message_ids: number[];
  input_texts: string[];
  batch_size: number;
  attempts: number;
  llm_model: string | null;
  llm_raw: string | null;
  parsed: unknown;
  reply: string | null;
  lookup_status: string | null;
  matched_price_ids: string[];
  escalate: Escalate | null;
  error_stage: string | null;
  error_message: string | null;
  superseded_by: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
}

export type RunStage =
  | 'queued'
  | 'debounce'
  | 'context'
  | 'llm_request'
  | 'llm_response'
  | 'json_valid'
  | 'json_invalid'
  | 'compose'
  | 'persist'
  | 'deliver'
  | 'done'
  | 'failed'
  | 'superseded';

export interface RunEvent {
  id?: number;
  run_id: string;
  thread_id: string | null;
  seq: number;
  stage: RunStage;
  level: 'info' | 'warn' | 'error';
  message: string;
  payload: Record<string, unknown>;
  duration_ms: number | null;
  created_at: string;
}

export interface Escalation {
  id: string;
  thread_id: string;
  run_id: string | null;
  reason: string;
  summary: string;
  context: Record<string, unknown>;
  status: EscalationStatus;
  resolved_by: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface ExternalEvent {
  id?: number;
  service: 'telegram' | 'whatsapp' | 'gemini' | 'apibazaar' | 'price_list' | 'supabase';
  operation: string;
  status: ExternalStatus;
  http_status: number | null;
  duration_ms: number | null;
  attempt: number;
  thread_id: string | null;
  run_id: string | null;
  request: unknown;
  response: unknown;
  error: string | null;
  created_at: string;
}

export interface PriceRow {
  id: string;
  make: string;
  model: string;
  year_from: number;
  year_to: number;
  glass_type: string;
  features: string;
  brand: string;
  price_glass: number;
  price_work: number;
  in_stock: string;
}

/** Как показывать найденные строки: все подряд или только самые дешёвые */
export type PriceSelection = 'all' | 'cheapest';

/** Схема ответа LLM (см. промпт) */
export interface LlmAnswer {
  reply: string;
  lookupStatus: 'not_requested' | 'need_details' | 'found' | 'found_multiple' | 'not_found';
  matchedPriceIds: string[];
  /** "cheapest" — клиент попросил самое дешёвое, отбор делает сервер */
  selection: PriceSelection;
  escalate: Escalate | null;
}
