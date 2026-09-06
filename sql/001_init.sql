-- =====================================================================
--  stekolshik_server — схема Supabase
--  Выполнить в Supabase → SQL Editor → New query → Run.
--  Скрипт идемпотентный: можно запускать повторно.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- ENUM-типы
-- ---------------------------------------------------------------------
do $$ begin
  create type thread_mode as enum ('ai', 'human');
exception when duplicate_object then null; end $$;

do $$ begin
  create type thread_status as enum ('open', 'closed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type message_role as enum ('customer', 'assistant', 'manager', 'system');
exception when duplicate_object then null; end $$;

do $$ begin
  create type run_status as enum ('queued', 'running', 'done', 'failed', 'superseded', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type escalation_status as enum ('new', 'in_progress', 'done');
exception when duplicate_object then null; end $$;

do $$ begin
  create type external_status as enum ('ok', 'error');
exception when duplicate_object then null; end $$;


-- ---------------------------------------------------------------------
-- 1. threads — диалоги с клиентами (замена n8n data table auto_glass_threads)
-- ---------------------------------------------------------------------
create table if not exists public.threads (
  id                uuid primary key default gen_random_uuid(),
  customer_chat_id  text          not null unique,   -- Telegram chat.id клиента
  customer_name     text          not null default '',
  customer_username text,
  topic_id          bigint,                          -- message_thread_id форум-топика в чате менеджеров
  mode              thread_mode   not null default 'ai',
  status            thread_status not null default 'open',
  last_message_at   timestamptz,
  last_message_text text,
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now()
);

create index if not exists threads_topic_id_idx        on public.threads (topic_id);
create index if not exists threads_last_message_at_idx on public.threads (last_message_at desc nulls last);
create index if not exists threads_mode_idx            on public.threads (mode);


-- ---------------------------------------------------------------------
-- 2. messages — история переписки (замена JSON-колонки history)
-- ---------------------------------------------------------------------
create table if not exists public.messages (
  id            bigserial primary key,
  thread_id     uuid         not null references public.threads(id) on delete cascade,
  role          message_role not null,
  text          text         not null default '',
  tg_message_id bigint,
  run_id        uuid,                                  -- каким прогоном LLM порождено (для role='assistant')
  meta          jsonb        not null default '{}'::jsonb,
  created_at    timestamptz  not null default now()
);

create index if not exists messages_thread_created_idx on public.messages (thread_id, created_at desc);
create index if not exists messages_run_idx            on public.messages (run_id);


-- ---------------------------------------------------------------------
-- 3. runs — прогоны оркестратора (один вызов LLM по N сообщениям клиента)
-- ---------------------------------------------------------------------
create table if not exists public.runs (
  id                 uuid       primary key default gen_random_uuid(),
  thread_id          uuid       not null references public.threads(id) on delete cascade,
  generation         integer    not null default 0,   -- счётчик поколений внутри чата
  status             run_status not null default 'queued',
  input_message_ids  bigint[]   not null default '{}',-- messages.id, вошедшие в этот прогон
  input_texts        text[]     not null default '{}',-- те же тексты (для отображения в UI)
  batch_size         integer    not null default 1,   -- N сообщений клиента в одном прогоне
  attempts           integer    not null default 0,   -- попыток получить валидный JSON
  llm_model          text,
  llm_raw            text,                            -- сырой ответ последней попытки
  parsed             jsonb,                           -- валидный JSON от LLM
  reply              text,                            -- финальный текст клиенту
  lookup_status      text,
  matched_price_ids  text[]     not null default '{}',
  escalate           jsonb,
  error_stage        text,
  error_message      text,
  superseded_by      uuid       references public.runs(id) on delete set null,
  queued_at          timestamptz not null default now(),
  started_at         timestamptz,
  finished_at        timestamptz,
  duration_ms        integer
);

create index if not exists runs_thread_idx    on public.runs (thread_id, queued_at desc);
create index if not exists runs_status_idx    on public.runs (status);
create index if not exists runs_queued_at_idx on public.runs (queued_at desc);


-- ---------------------------------------------------------------------
-- 4. run_events — этапы прогона (то, что рисуется на вкладке «Оркестрация»)
-- ---------------------------------------------------------------------
create table if not exists public.run_events (
  id          bigserial   primary key,
  run_id      uuid        not null references public.runs(id) on delete cascade,
  thread_id   uuid        references public.threads(id) on delete cascade,
  seq         integer     not null default 0,   -- порядок этапа внутри прогона (метки времени могут совпасть)
  stage       text        not null,   -- queued | debounce | context | llm_request | llm_response |
                                      -- json_valid | json_invalid | compose | persist | deliver |
                                      -- done | failed | superseded
  level       text        not null default 'info',  -- info | warn | error
  message     text        not null default '',
  payload     jsonb       not null default '{}'::jsonb,
  duration_ms integer,
  created_at  timestamptz not null default now()
);

create index if not exists run_events_run_idx     on public.run_events (run_id, seq);
create index if not exists run_events_created_idx on public.run_events (created_at desc);


-- ---------------------------------------------------------------------
-- 5. escalations — запросы к менеджеру (вкладка «Менеджеру»)
-- ---------------------------------------------------------------------
create table if not exists public.escalations (
  id          uuid              primary key default gen_random_uuid(),
  thread_id   uuid              not null references public.threads(id) on delete cascade,
  run_id      uuid              references public.runs(id) on delete set null,
  reason      text              not null,   -- deal_ready | price_not_found | not_in_stock |
                                            -- ai_unavailable | price_source_unavailable | manual
  summary     text              not null default '',
  context     jsonb             not null default '{}'::jsonb,
  status      escalation_status not null default 'new',
  resolved_by text,
  created_at  timestamptz       not null default now(),
  resolved_at timestamptz
);

create index if not exists escalations_status_idx on public.escalations (status, created_at desc);
create index if not exists escalations_thread_idx on public.escalations (thread_id, created_at desc);


-- ---------------------------------------------------------------------
-- 6. external_events — журнал ВСЕХ внешних взаимодействий и их ошибок
-- ---------------------------------------------------------------------
create table if not exists public.external_events (
  id          bigserial       primary key,
  service     text            not null,   -- telegram | gemini | price_list | supabase
  operation   text            not null,   -- sendMessage | createForumTopic | generateContent | fetchCsv
  status      external_status not null,
  http_status integer,
  duration_ms integer,
  attempt     integer         not null default 1,
  thread_id   uuid,
  run_id      uuid,
  request     jsonb,
  response    jsonb,
  error       text,
  created_at  timestamptz     not null default now()
);

create index if not exists external_events_created_idx on public.external_events (created_at desc);
create index if not exists external_events_status_idx  on public.external_events (status, created_at desc);
create index if not exists external_events_service_idx on public.external_events (service, created_at desc);


-- ---------------------------------------------------------------------
-- 7. app_settings — глобальные настройки (например, «пауза бота»)
-- ---------------------------------------------------------------------
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (key, value)
values ('global_mode', '{"paused": false}'::jsonb)
on conflict (key) do nothing;


-- ---------------------------------------------------------------------
-- Триггер updated_at для threads
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $fn$
begin
  new.updated_at := now();
  return new;
end $fn$;

drop trigger if exists threads_touch_updated_at on public.threads;
create trigger threads_touch_updated_at
  before update on public.threads
  for each row execute function public.touch_updated_at();


-- ---------------------------------------------------------------------
-- Безопасность: RLS включён, публичных политик нет.
-- Сервер ходит с SERVICE_ROLE ключом и обходит RLS.
-- Анонимный ключ не даёт доступа ни к одной таблице.
-- ---------------------------------------------------------------------
alter table public.threads         enable row level security;
alter table public.messages        enable row level security;
alter table public.runs            enable row level security;
alter table public.run_events      enable row level security;
alter table public.escalations     enable row level security;
alter table public.external_events enable row level security;
alter table public.app_settings    enable row level security;


-- ---------------------------------------------------------------------
-- Служебная очистка старых логов (вызывать по расписанию при желании):
--   select public.purge_old_logs(14);
-- ---------------------------------------------------------------------
create or replace function public.purge_old_logs(days integer default 14)
returns void language plpgsql as $fn$
begin
  delete from public.external_events where created_at < now() - make_interval(days => days);
  delete from public.run_events      where created_at < now() - make_interval(days => days);
end $fn$;
