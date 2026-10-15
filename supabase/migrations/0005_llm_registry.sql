-- 0005_llm_registry.sql
-- PinMentor Batch 02, part 1: model registry, effective-dated prices, task routes, LLM call/cost log,
-- credit rates, feature flags. Requires 0001-0004. Paste into Supabase SQL Editor and run once.
--
-- CLAUDE.md: "Model IDs and prices live in model_registry — never hardcode." So every model id, price and
-- route is DATA here; the application only reads it (through src/modules/llm).
--
-- Global configuration tables (model_registry, model_prices, llm_routes, credit_rates, feature_flags) carry
-- no workspace_id on purpose (same as `languages`). RLS is ON for all of them with NO client policies and
-- no client grants: only the server (service_role) reads or writes them. `llm_calls` is workspace data:
-- it has workspace_id + RLS (deny-all for clients: costs/margins are internal).
--
-- Prices were read from the providers' official pricing pages on 2026-10-14 (see model_prices.source).
-- They change often: re-check before launch, and add a NEW model_prices row (new effective_from) instead of
-- editing old rows, so past llm_calls stay explainable.

-- ---------------------------------------------------------------------------
-- credit_rates (PLAN §11): action -> credits. Admin-editable later (Phase 7); only the test action for now.
-- ---------------------------------------------------------------------------
create table public.credit_rates (
  action     text primary key check (action ~ '^[a-z][a-z0-9_.]{1,63}$'),
  credits    integer not null check (credits >= 0),
  updated_at timestamptz not null default now()
);

insert into public.credit_rates (action, credits) values ('test_job', 1);

-- ---------------------------------------------------------------------------
-- feature_flags (PLAN §11)
-- ---------------------------------------------------------------------------
create table public.feature_flags (
  key        text primary key check (key ~ '^[a-z][a-z0-9_.]{1,63}$'),
  enabled    boolean not null default false,
  rules      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.feature_flags (key, enabled, rules) values
  ('unsplash_provider', false, '{}'),                     -- CLAUDE.md: Unsplash stays OFF
  ('llm_kill_switch',   false, '{}'),                     -- ON = every LLM call is refused (PLAN §10.2 kill-switch)
  ('llm_budget_guard',  false, '{"daily_usd": 10}');      -- ON = refuse LLM calls once today's (UTC) cost reaches daily_usd

-- ---------------------------------------------------------------------------
-- model_registry + model_prices
-- ---------------------------------------------------------------------------
create table public.model_registry (
  key                  text primary key check (key ~ '^[a-z0-9][a-z0-9._-]{1,63}$'),
  provider             text not null check (provider in ('anthropic', 'openai', 'gemini')),
  model_id             text not null,
  display_name         text not null,
  context_window       integer,
  max_output_tokens    integer,
  supports_temperature boolean not null default true,
  enabled              boolean not null default true,
  notes                text,
  created_at           timestamptz not null default now(),
  unique (provider, model_id)
);

create table public.model_prices (
  model_key                      text not null references public.model_registry (key) on delete cascade,
  effective_from                 date not null,
  input_usd_per_mtok             numeric(12, 6) not null check (input_usd_per_mtok >= 0),
  output_usd_per_mtok            numeric(12, 6) not null check (output_usd_per_mtok >= 0),
  cached_input_usd_per_mtok      numeric(12, 6) check (cached_input_usd_per_mtok >= 0),   -- null = bill cached tokens as normal input
  long_context_threshold         integer check (long_context_threshold > 0),               -- prompts ABOVE this use the long_* prices
  long_input_usd_per_mtok        numeric(12, 6) check (long_input_usd_per_mtok >= 0),
  long_output_usd_per_mtok       numeric(12, 6) check (long_output_usd_per_mtok >= 0),
  long_cached_input_usd_per_mtok numeric(12, 6) check (long_cached_input_usd_per_mtok >= 0),
  source                         text not null,
  checked_on                     date not null,
  primary key (model_key, effective_from),
  check (
    (long_context_threshold is null and long_input_usd_per_mtok is null and long_output_usd_per_mtok is null and long_cached_input_usd_per_mtok is null)
    or (long_context_threshold is not null and long_input_usd_per_mtok is not null and long_output_usd_per_mtok is not null)
  )
);

-- Seeds. Anthropic ids come from Anthropic's own model list; all prices from the official pricing pages (2026-10-14).
insert into public.model_registry (key, provider, model_id, display_name, context_window, max_output_tokens, supports_temperature, notes) values
  ('anthropic.haiku-5-5',  'anthropic', 'claude-haiku-5-5',  'Claude Haiku 5.5',  null, null, true, 'cheap tier; prompts over 100k tokens use the long tier price'),
  ('anthropic.sonnet-5-5', 'anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', null, null, true, 'mid / article default'),
  ('anthropic.opus-5-5',   'anthropic', 'claude-opus-5-5',   'Claude Opus 5.5',   null, null, true, 'premium articles'),
  ('gemini.3-8-flash',     'gemini',    'gemini-3.8-flash',      'Gemini 3.8 Flash',      null, null, true, 'intro price until 2026-12-31, doubles from 2027-01-01 (second price row); output price includes thinking tokens'),
  ('gemini.3-5-flash-lite','gemini',    'gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', null, null, true, 'cheap tier; output price includes thinking tokens'),
  ('openai.gpt-6-1-sol',   'openai',    'gpt-6.1-sol',  'GPT-6.1 Sol',  null, null, false, 'mid tier; long-context tier exists but its threshold was not stated on the pricing page: VERIFY, then fill long_context_threshold'),
  ('openai.gpt-6-luna',    'openai',    'gpt-6-luna',   'GPT-6 Luna',   null, null, false, 'cheap tier; long-context tier exists but its threshold was not stated on the pricing page: VERIFY');

insert into public.model_prices
  (model_key, effective_from, input_usd_per_mtok, output_usd_per_mtok, cached_input_usd_per_mtok,
   long_context_threshold, long_input_usd_per_mtok, long_output_usd_per_mtok, long_cached_input_usd_per_mtok, source, checked_on)
values
  ('anthropic.haiku-5-5',   '2026-01-01', 0.10, 0.50, 0.01, 100000, 0.50, 2.50, 0.05, 'platform.claude.com/docs/en/about-claude/pricing', '2026-10-14'),
  ('anthropic.sonnet-5-5',  '2026-01-01', 2.00, 10.00, 0.10, null, null, null, null,  'platform.claude.com/docs/en/about-claude/pricing', '2026-10-14'),
  ('anthropic.opus-5-5',    '2026-01-01', 4.00, 20.00, 0.20, null, null, null, null,  'platform.claude.com/docs/en/about-claude/pricing', '2026-10-14'),
  ('gemini.3-8-flash',      '2026-01-01', 0.75, 3.75,  null, null, null, null, null,  'ai.google.dev/gemini-api/docs/pricing (intro price through 2026-12-31)', '2026-10-14'),
  ('gemini.3-8-flash',      '2027-01-01', 1.50, 7.50,  null, null, null, null, null,  'ai.google.dev/gemini-api/docs/pricing (price from 2027-01-01)', '2026-10-14'),
  ('gemini.3-5-flash-lite', '2026-01-01', 0.30, 2.50,  null, null, null, null, null,  'ai.google.dev/gemini-api/docs/pricing', '2026-10-14'),
  ('openai.gpt-6-1-sol',    '2026-01-01', 2.00, 10.00, 0.10, null, null, null, null,  'developers.openai.com/api/docs/pricing (long tier 4.00/15.00, cached 0.20: threshold unknown, not applied)', '2026-10-14'),
  ('openai.gpt-6-luna',     '2026-01-01', 0.10, 0.50,  0.01, null, null, null, null,  'developers.openai.com/api/docs/pricing (long tier 0.20/0.75, cached 0.02: threshold unknown, not applied)', '2026-10-14');

-- ---------------------------------------------------------------------------
-- llm_routes: task -> ordered fallback chain of model keys (PLAN §13 classes). Editable data.
-- ---------------------------------------------------------------------------
create table public.llm_routes (
  task        text primary key check (task ~ '^[a-z][a-z0-9_]{1,63}$'),
  model_keys  text[] not null check (cardinality(model_keys) between 1 and 8),
  description text
);

create function public.llm_routes_validate()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  k text;
begin
  foreach k in array new.model_keys loop
    if not exists (select 1 from public.model_registry r where r.key = k) then
      raise exception 'llm_routes: unknown model key %', k using errcode = '23503';
    end if;
  end loop;
  return new;
end;
$$;

create trigger llm_routes_validate_trg
  before insert or update on public.llm_routes
  for each row execute function public.llm_routes_validate();

revoke all on function public.llm_routes_validate() from public, anon, authenticated;

insert into public.llm_routes (task, model_keys, description) values
  -- cheap class: facets, keywords, titles, pin copy, image queries
  ('facet_generation',    array['anthropic.haiku-5-5','gemini.3-5-flash-lite','openai.gpt-6-luna'], 'cheap'),
  ('keyword_generation',  array['anthropic.haiku-5-5','gemini.3-5-flash-lite','openai.gpt-6-luna'], 'cheap'),
  ('title_generation',    array['anthropic.haiku-5-5','gemini.3-5-flash-lite','openai.gpt-6-luna'], 'cheap'),
  ('pin_copy',            array['anthropic.haiku-5-5','gemini.3-5-flash-lite','openai.gpt-6-luna'], 'cheap'),
  ('image_query',         array['anthropic.haiku-5-5','gemini.3-5-flash-lite','openai.gpt-6-luna'], 'cheap'),
  -- mid class: borderline intent judging, research + outline
  ('intent_judge',        array['anthropic.sonnet-5-5','gemini.3-8-flash','openai.gpt-6-1-sol'], 'mid'),
  ('research_outline',    array['anthropic.sonnet-5-5','gemini.3-8-flash','openai.gpt-6-1-sol'], 'mid'),
  -- articles
  ('article_write',         array['anthropic.sonnet-5-5','gemini.3-8-flash','openai.gpt-6-1-sol'], 'mid-high default'),
  ('article_write_premium', array['anthropic.opus-5-5','anthropic.sonnet-5-5','openai.gpt-6-1-sol'], 'premium'),
  -- audits / cross-judge: callers pass avoidProvider so the judge is a DIFFERENT provider than the producer
  ('map_audit',           array['gemini.3-8-flash','openai.gpt-6-1-sol','anthropic.sonnet-5-5'], 'cross-provider'),
  ('qa_cross_judge',      array['gemini.3-8-flash','openai.gpt-6-1-sol','anthropic.sonnet-5-5'], 'cross-provider'),
  -- plumbing test
  ('test_echo',           array['anthropic.haiku-5-5','gemini.3-5-flash-lite','openai.gpt-6-luna'], 'smoke test');

-- ---------------------------------------------------------------------------
-- llm_calls: one row per provider attempt (success or failure). Source of truth for cost + provider health.
-- ---------------------------------------------------------------------------
create table public.llm_calls (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces (id) on delete cascade,
  job_id              uuid,                       -- FK added in 0006 (jobs table)
  task                text not null,
  provider            text not null,
  model_key           text not null,              -- snapshots, no FK: history must survive registry edits
  model_id            text not null,
  attempt             integer not null default 1 check (attempt >= 1),
  status              text not null check (status in ('ok', 'error', 'invalid_output')),
  error_code          text,
  http_status         integer,
  input_tokens        integer not null default 0 check (input_tokens >= 0),
  output_tokens       integer not null default 0 check (output_tokens >= 0),
  cached_input_tokens integer not null default 0 check (cached_input_tokens >= 0),
  cost_usd            numeric(12, 6) not null default 0 check (cost_usd >= 0),
  price_effective_from date,
  latency_ms          integer check (latency_ms >= 0),
  provider_request_id text,
  byok                boolean not null default false,
  created_at          timestamptz not null default now()
);
create index llm_calls_created_idx on public.llm_calls (created_at);
create index llm_calls_workspace_created_idx on public.llm_calls (workspace_id, created_at);
create index llm_calls_provider_created_idx on public.llm_calls (provider, created_at);

-- ---------------------------------------------------------------------------
-- Route resolution: the models of a task's chain that are enabled AND have a price in force today, in order.
-- ---------------------------------------------------------------------------
create function public.llm_route_models(p_task text, p_on date default (now() at time zone 'utc')::date)
returns table (
  pos                            integer,
  model_key                      text,
  provider                       text,
  model_id                       text,
  max_output_tokens              integer,
  supports_temperature           boolean,
  price_effective_from           date,
  input_usd_per_mtok             numeric,
  output_usd_per_mtok            numeric,
  cached_input_usd_per_mtok      numeric,
  long_context_threshold         integer,
  long_input_usd_per_mtok        numeric,
  long_output_usd_per_mtok       numeric,
  long_cached_input_usd_per_mtok numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.ord::integer,
    m.key,
    m.provider,
    m.model_id,
    m.max_output_tokens,
    m.supports_temperature,
    p.effective_from,
    p.input_usd_per_mtok,
    p.output_usd_per_mtok,
    p.cached_input_usd_per_mtok,
    p.long_context_threshold,
    p.long_input_usd_per_mtok,
    p.long_output_usd_per_mtok,
    p.long_cached_input_usd_per_mtok
  from public.llm_routes r
  cross join lateral unnest(r.model_keys) with ordinality as c(mkey, ord)
  join public.model_registry m on m.key = c.mkey and m.enabled
  join lateral (
    select mp.*
    from public.model_prices mp
    where mp.model_key = m.key and mp.effective_from <= p_on
    order by mp.effective_from desc
    limit 1
  ) p on true
  where r.task = p_task
  order by c.ord;
$$;

-- ---------------------------------------------------------------------------
-- Budget guard + kill switch
-- ---------------------------------------------------------------------------
create function public.llm_budget_check()
returns table (allowed boolean, reason text, spent_today_usd numeric, daily_limit_usd numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kill   boolean;
  v_guard  boolean;
  v_rules  jsonb;
  v_limit  numeric;
  v_spent  numeric;
begin
  select f.enabled into v_kill from public.feature_flags f where f.key = 'llm_kill_switch';
  select f.enabled, f.rules into v_guard, v_rules from public.feature_flags f where f.key = 'llm_budget_guard';

  select coalesce(sum(l.cost_usd), 0) into v_spent
  from public.llm_calls l
  where l.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';

  v_limit := case when v_rules ? 'daily_usd' and jsonb_typeof(v_rules -> 'daily_usd') = 'number'
                  then (v_rules ->> 'daily_usd')::numeric else null end;

  if coalesce(v_kill, false) then
    return query select false, 'kill_switch'::text, v_spent, v_limit;
  elsif coalesce(v_guard, false) and v_limit is not null and v_spent >= v_limit then
    return query select false, 'daily_budget'::text, v_spent, v_limit;
  else
    return query select true, null::text, v_spent, v_limit;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Usage summary for the admin page
-- ---------------------------------------------------------------------------
create function public.admin_llm_usage(p_hours integer default 24)
returns table (
  provider      text,
  model_key     text,
  calls         bigint,
  errors        bigint,
  input_tokens  bigint,
  output_tokens bigint,
  cost_usd      numeric,
  avg_latency_ms integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    l.provider,
    l.model_key,
    count(*),
    count(*) filter (where l.status <> 'ok'),
    coalesce(sum(l.input_tokens), 0)::bigint,
    coalesce(sum(l.output_tokens), 0)::bigint,
    coalesce(sum(l.cost_usd), 0),
    coalesce(avg(l.latency_ms) filter (where l.status = 'ok'), 0)::integer
  from public.llm_calls l
  where l.created_at >= now() - make_interval(hours => least(greatest(coalesce(p_hours, 24), 1), 24 * 90))
  group by l.provider, l.model_key
  order by sum(l.cost_usd) desc, l.provider, l.model_key;
$$;

-- ---------------------------------------------------------------------------
-- Retention for the cost log (free-tier disk is 500MB). Schedule it daily (see supabase/ops/schedule_jobs.sql).
-- ---------------------------------------------------------------------------
create function public.purge_old_llm_calls(p_days integer default 90)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted bigint;
begin
  if p_days is null or p_days < 30 then
    raise exception 'llm_calls must be kept at least 30 days' using errcode = '22023';
  end if;
  delete from public.llm_calls where created_at < now() - make_interval(days => p_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges + RLS: everything here is server-only.
-- ---------------------------------------------------------------------------
alter table public.credit_rates   enable row level security;
alter table public.feature_flags  enable row level security;
alter table public.model_registry enable row level security;
alter table public.model_prices   enable row level security;
alter table public.llm_routes     enable row level security;
alter table public.llm_calls      enable row level security;

revoke all on public.credit_rates, public.feature_flags, public.model_registry, public.model_prices,
              public.llm_routes, public.llm_calls
  from public, anon, authenticated;

revoke all on function public.llm_route_models(text, date)      from public, anon, authenticated;
revoke all on function public.llm_budget_check()                from public, anon, authenticated;
revoke all on function public.admin_llm_usage(integer)          from public, anon, authenticated;
revoke all on function public.purge_old_llm_calls(integer)      from public, anon, authenticated;

grant execute on function public.llm_route_models(text, date)   to service_role;
grant execute on function public.llm_budget_check()             to service_role;
grant execute on function public.admin_llm_usage(integer)       to service_role;
grant execute on function public.purge_old_llm_calls(integer)   to service_role;
