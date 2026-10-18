-- 0008_topical_map.sql
-- PinMentor Batch 05, part 1: topical-map tables (PLAN §11), run lifecycle with credit hold, embedding-model kind.
-- Requires 0001-0007. Paste into Supabase SQL Editor and run ONCE, then run supabase/tests/rls_0008.sql.
-- pgvector (the embedding column + neighbour search) is deliberately NOT here: it lives in 0009 so that this file
-- can be tested end to end on a plain Postgres.
--
-- Access model: workspace members may READ their own map data (RLS). Every write goes through the server
-- (service_role) via the functions below or the app's admin client, never from the browser.
-- golden_pairs is the global eval set (like `languages`): RLS on, no client policy.
--
-- Credits (CLAUDE.md "reserve -> commit/release, idempotency key"): map_run_create reserves
-- map_credit_cost(target_max) in the SAME transaction that creates the run; map_run_finish commits or releases it.
-- Stage jobs are enqueued WITHOUT their own credit action, so a run is charged exactly once.

-- ---------------------------------------------------------------------------
-- model_registry: embedding models live next to chat models (never hardcoded in code)
-- ---------------------------------------------------------------------------
alter table public.model_registry
  add column kind text not null default 'chat' check (kind in ('chat', 'embedding')),
  add column dimensions integer check (dimensions > 0);

-- Verified 2026-10-17: OpenAI text-embedding-3-small, $0.02 per 1M input tokens (developers.openai.com model page),
-- 1536 dimensions by default (the plan's vector(1536)). model_prices needs an output price: embeddings have none -> 0.
insert into public.model_registry (key, provider, model_id, display_name, kind, dimensions, supports_temperature, notes) values
  ('openai.text-embedding-3-small', 'openai', 'text-embedding-3-small', 'OpenAI text-embedding-3-small', 'embedding', 1536, false,
   '8192 tokens per input; 1536 dims natively'),
  ('gemini.embedding-2', 'gemini', 'gemini-embedding-2', 'Gemini Embedding 2', 'embedding', 1536, false,
   'DISABLED until a price row is added: the price could not be read from the official pricing page on 2026-10-17. Output is cut to 1536 dims via output_dimensionality.');
update public.model_registry set enabled = false where key = 'gemini.embedding-2';

insert into public.model_prices
  (model_key, effective_from, input_usd_per_mtok, output_usd_per_mtok, cached_input_usd_per_mtok, source, checked_on)
values
  ('openai.text-embedding-3-small', '2026-01-01', 0.02, 0, null, 'developers.openai.com/api/docs/models/text-embedding-3-small (Embeddings, per 1M tokens)', '2026-10-17');

insert into public.llm_routes (task, model_keys, description) values
  ('embedding', array['openai.text-embedding-3-small', 'gemini.embedding-2'], 'embedding: keyword dedup (S4)');

-- map cost = 10 + 5 x ceil(items / 25)  (PLAN §3.11). A formula, so it is a function, not a credit_rates row.
create function public.map_credit_cost(p_items integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select 10 + 5 * ceil(greatest(p_items, 1) / 25.0)::integer;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.projects (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  site_id      uuid,                                    -- FK arrives with the `sites` table (WordPress batch)
  name         text not null check (char_length(name) between 1 and 120),
  topic        text not null check (char_length(topic) between 2 and 200),
  language     text not null check (language ~ '^[a-z]{2}$'),
  locale       text not null check (locale ~ '^[a-z]{2}-[A-Z]{2}$'),
  status       text not null default 'active' check (status in ('active', 'archived')),
  created_at   timestamptz not null default now()
);
create index projects_workspace_idx on public.projects (workspace_id, created_at desc);

create table public.map_runs (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  project_id       uuid not null references public.projects (id) on delete cascade,
  created_by       uuid references auth.users (id) on delete set null,
  topic            text not null,
  language         text not null,
  locale           text not null,
  target_min       integer not null check (target_min between 10 and 1000),
  target_max       integer not null check (target_max between 10 and 1000),
  mode             text not null default 'fast' check (mode in ('fast', 'economy')),
  status           text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  stage            text not null default 's1_facets',
  params           jsonb not null default '{}'::jsonb,
  stats            jsonb not null default '{}'::jsonb,
  report           jsonb,
  credit_amount    integer not null default 0 check (credit_amount >= 0),
  credit_ledger_id uuid,
  last_error       text,
  parallel_group_id uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  finished_at      timestamptz,
  check (target_min <= target_max)
);
create index map_runs_workspace_idx on public.map_runs (workspace_id, created_at desc);
create index map_runs_active_idx on public.map_runs (status) where status in ('queued', 'running');

create table public.facets (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  map_run_id   uuid not null references public.map_runs (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 80),
  kind         text not null default 'other',
  parent_id    uuid references public.facets (id) on delete cascade,   -- null = facet, set = one value of that facet
  notes        text
);
create index facets_run_idx on public.facets (map_run_id);

create table public.kw_candidates (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  map_run_id     uuid not null references public.map_runs (id) on delete cascade,
  raw            text not null check (char_length(raw) between 1 and 200),
  raw_key        text not null,                          -- lower(trim(raw)): idempotent inserts (a retried job adds nothing twice)
  norm_key       text,                                   -- S3 token-set key; filled by the normalise stage
  lang           text not null,
  source         text not null check (char_length(source) between 1 and 40),
  facet_id       uuid references public.facets (id) on delete set null,
  seq            integer,                                -- position among surviving candidates (chunk key for S4)
  status         text not null default 'raw' check (status in ('raw', 'merged', 'primary', 'dropped')),
  merged_into    uuid references public.kw_candidates (id) on delete set null,
  merge_reason   text,
  intent         text,
  funnel         text,
  demand_tier    smallint check (demand_tier between 1 and 5),
  demand_source  text check (demand_source in ('provider', 'estimate')),
  volume         integer,
  difficulty     integer,
  comp_score     smallint,
  priority       numeric,
  flags          text[] not null default '{}',
  created_at     timestamptz not null default now(),
  unique (map_run_id, raw_key)
);
create index kw_candidates_run_status_idx on public.kw_candidates (map_run_id, status);
create index kw_candidates_run_seq_idx on public.kw_candidates (map_run_id, seq) where seq is not null;
create index kw_candidates_norm_idx on public.kw_candidates (map_run_id, norm_key);

create table public.kw_pairs (
  map_run_id   uuid not null references public.map_runs (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  a            uuid not null references public.kw_candidates (id) on delete cascade,
  b            uuid not null references public.kw_candidates (id) on delete cascade,
  cosine       real,
  verdict      text check (verdict in ('same', 'parent_child', 'related', 'different')),   -- null = waiting for the judge
  judged_by    text,                                    -- rule | cosine | judge
  reason       text,
  created_at   timestamptz not null default now(),
  primary key (map_run_id, a, b),
  check (a < b)
);
create index kw_pairs_pending_idx on public.kw_pairs (map_run_id) where verdict is null;

create table public.golden_pairs (
  id        uuid primary key default gen_random_uuid(),
  language  text not null,
  a         text not null,
  b         text not null,
  label     text not null check (label in ('same', 'parent_child', 'related', 'different', 'uncertain')),
  split     text not null default 'dev' check (split in ('dev', 'test')),
  status    text not null default 'provisional' check (status in ('provisional', 'confirmed')),
  labeled_by text not null,
  note      text,
  created_at timestamptz not null default now(),
  unique (language, a, b)
);

-- touch updated_at
create function public.map_runs_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger map_runs_touch_trg before update on public.map_runs for each row execute function public.map_runs_touch();

-- ---------------------------------------------------------------------------
-- Run lifecycle
-- ---------------------------------------------------------------------------

-- Creates a project (when none is given) + run, reserves credits, enqueues S1. Idempotent on p_key.
-- Errors: 42501 not a member, 22023 bad argument, PM001 insufficient credits (from the ledger).
create function public.map_run_create(
  p_workspace  uuid,
  p_user       uuid,
  p_topic      text,
  p_language   text,
  p_locale     text,
  p_target_min integer,
  p_target_max integer,
  p_mode       text,
  p_key        text,
  p_project    uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing uuid;
  v_project  uuid := p_project;
  v_run      uuid := gen_random_uuid();
  v_amount   integer;
  v_ledger   uuid;
  v_topic    text := btrim(coalesce(p_topic, ''));
begin
  if p_key is null or btrim(p_key) = '' or char_length(p_key) > 150 then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;
  if char_length(v_topic) < 2 or char_length(v_topic) > 200 then
    raise exception 'invalid_topic' using errcode = '22023';
  end if;
  if p_target_min is null or p_target_max is null or p_target_min < 10 or p_target_max > 1000 or p_target_min > p_target_max then
    raise exception 'invalid_target' using errcode = '22023';
  end if;
  if p_mode not in ('fast', 'economy') then
    raise exception 'invalid_mode' using errcode = '22023';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = p_workspace and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('map_run:' || p_workspace::text || ':' || p_key, 0));

  select r.id into v_existing from public.map_runs r
  where r.workspace_id = p_workspace and r.params ->> 'idempotency_key' = p_key;
  if found then
    return v_existing;
  end if;

  if v_project is not null then
    if not exists (select 1 from public.projects pr where pr.id = v_project and pr.workspace_id = p_workspace) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  else
    insert into public.projects (workspace_id, name, topic, language, locale)
    values (p_workspace, left(v_topic, 120), v_topic, p_language, p_locale)
    returning id into v_project;
  end if;

  v_amount := public.map_credit_cost(p_target_max);
  v_ledger := public.credit_reserve(p_workspace, v_amount, 'map_run', 'map-run-reserve:' || v_run::text, 'map_run', v_run::text);

  insert into public.map_runs (id, workspace_id, project_id, created_by, topic, language, locale, target_min, target_max, mode,
                               status, stage, params, credit_amount, credit_ledger_id)
  values (v_run, p_workspace, v_project, p_user, v_topic, p_language, p_locale, p_target_min, p_target_max, p_mode,
          'queued', 's1_facets', jsonb_build_object('idempotency_key', p_key), v_amount, v_ledger);

  perform public.job_enqueue(p_workspace, 'map.s1_facets', jsonb_build_object('mapRunId', v_run),
                             'map:' || v_run::text || ':s1', null, now(), 3, 0, null, null, 's1_facets');
  return v_run;
end;
$$;

-- Ends a run: success commits the held credits, failure/cancel releases them. Replay-safe.
create function public.map_run_finish(p_run uuid, p_status text, p_error text default null, p_stats jsonb default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.map_runs;
begin
  if p_status not in ('succeeded', 'failed', 'canceled') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  select * into r from public.map_runs where id = p_run for update;
  if not found then
    raise exception 'map_run_not_found' using errcode = 'PM004';
  end if;
  if r.status in ('succeeded', 'failed', 'canceled') then
    return r.status;   -- already final
  end if;

  if r.credit_ledger_id is not null then
    if p_status = 'succeeded' then
      perform public.credit_commit(r.credit_ledger_id);
    else
      perform public.credit_release(r.credit_ledger_id);
    end if;
  end if;

  update public.map_runs
  set status = p_status, finished_at = now(), last_error = left(p_error, 300),
      stats = coalesce(p_stats, stats), stage = case when p_status = 'succeeded' then 'done' else stage end
  where id = p_run;

  if p_status <> 'succeeded' then
    update public.jobs set state = 'canceled', finished_at = now(), locked_by = null, lease_expires_at = null
    where payload ->> 'mapRunId' = p_run::text and state = 'queued' and type like 'map.%';
  end if;
  return p_status;
end;
$$;

create function public.map_run_set_stage(p_run uuid, p_stage text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.map_runs set stage = p_stage, status = 'running'
  where id = p_run and status in ('queued', 'running');
$$;

-- Job counts of one stage type for one run (the coordinator polls this instead of racing on completion events).
create function public.map_stage_status(p_run uuid, p_type text)
returns table (queued bigint, running bigint, succeeded bigint, dead bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select
    count(*) filter (where j.state = 'queued'),
    count(*) filter (where j.state = 'running'),
    count(*) filter (where j.state = 'succeeded'),
    count(*) filter (where j.state in ('dead', 'canceled'))
  from public.jobs j
  where j.type = p_type and j.payload ->> 'mapRunId' = p_run::text;
$$;

-- Safety net called from every worker tick: a run with a dead stage job, or with no live job for a long while,
-- is failed and its credits are released (otherwise the hold would sit there until someone noticed).
create function public.map_run_watchdog(p_idle_minutes integer default 20)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_n integer := 0;
begin
  for r in
    select m.id,
           exists (select 1 from public.jobs j where j.payload ->> 'mapRunId' = m.id::text and j.type like 'map.%' and j.state = 'dead') as has_dead,
           exists (select 1 from public.jobs j where j.payload ->> 'mapRunId' = m.id::text and j.type like 'map.%' and j.state in ('queued', 'running')) as has_live
    from public.map_runs m
    where m.status in ('queued', 'running')
      and m.updated_at < now() - make_interval(mins => 1)
  loop
    if r.has_dead then
      perform public.map_run_finish(r.id, 'failed', 'a stage job failed permanently');
      v_n := v_n + 1;
    elsif not r.has_live and exists (select 1 from public.map_runs m where m.id = r.id and m.updated_at < now() - make_interval(mins => greatest(p_idle_minutes, 5))) then
      perform public.map_run_finish(r.id, 'failed', 'run stalled: no job left to advance it');
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

create function public.map_run_cancel(p_run uuid, p_user uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
begin
  select workspace_id into v_ws from public.map_runs where id = p_run;
  if v_ws is null then
    raise exception 'map_run_not_found' using errcode = 'PM004';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = v_ws and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return public.map_run_finish(p_run, 'canceled', 'canceled by user');
end;
$$;

-- Superadmin entry point (own workspace only, like admin_enqueue_test_job). Writes admin_audit.
create function public.admin_map_run_create(
  p_admin      uuid,
  p_workspace  uuid,
  p_topic      text,
  p_language   text,
  p_locale     text,
  p_target_min integer,
  p_target_max integer,
  p_mode       text,
  p_key        text,
  p_ip         text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role    text;
  v_owner   uuid;
  v_existed boolean;
  v_id      uuid;
begin
  select p.role into v_role from public.profiles p where p.user_id = p_admin;
  if v_role is distinct from 'superadmin' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select w.owner_id into v_owner from public.workspaces w where w.id = p_workspace;
  if v_owner is distinct from p_admin then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select exists (select 1 from public.map_runs r where r.workspace_id = p_workspace and r.params ->> 'idempotency_key' = 'admin:' || p_key)
    into v_existed;
  v_id := public.map_run_create(p_workspace, p_admin, p_topic, p_language, p_locale, p_target_min, p_target_max, p_mode, 'admin:' || p_key);

  if not v_existed then
    insert into public.admin_audit (admin_id, action, target_type, target_id, diff, ip)
    values (p_admin, 'map_run_create', 'map_run', v_id::text,
            jsonb_build_object('workspace_id', p_workspace, 'target_max', p_target_max, 'mode', p_mode,
                               'credits', public.map_credit_cost(p_target_max)), p_ip);
  end if;
  return v_id;
end;
$$;

-- Read helper for /admin/maps: recent runs with live counters.
create function public.admin_map_run_list(p_limit integer default 20)
returns table (
  id uuid, workspace_id uuid, topic text, locale text, target_max integer, status text, stage text,
  credit_amount integer, candidates bigint, primaries bigint, last_error text, created_at timestamptz, finished_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.workspace_id, r.topic, r.locale, r.target_max, r.status, r.stage, r.credit_amount,
         (select count(*) from public.kw_candidates c where c.map_run_id = r.id),
         (select count(*) from public.kw_candidates c where c.map_run_id = r.id and c.status = 'primary'),
         r.last_error, r.created_at, r.finished_at
  from public.map_runs r
  order by r.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

-- ---------------------------------------------------------------------------
-- Stage helpers (one round trip each; PostgREST cannot update many rows to different values)
-- ---------------------------------------------------------------------------

-- p_items = [{"id": uuid, "norm_key"?, "seq"?, "status"?, "merged_into"?, "merge_reason"?}, ...]; absent fields stay as they are.
create function public.kw_apply_updates(p_run uuid, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) > 1000 then
    raise exception 'invalid_items' using errcode = '22023';
  end if;
  update public.kw_candidates c
  set norm_key     = coalesce(i.norm_key, c.norm_key),
      seq          = coalesce(i.seq, c.seq),
      status       = coalesce(i.status, c.status),
      merged_into  = coalesce(i.merged_into, c.merged_into),
      merge_reason = coalesce(i.merge_reason, c.merge_reason)
  from jsonb_to_recordset(p_items) as i(id uuid, norm_key text, seq integer, status text, merged_into uuid, merge_reason text)
  where c.id = i.id and c.map_run_id = p_run;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Pairs still waiting for the intent judge, one hash slot of them (so parallel judge jobs never take the same pair).
create function public.kw_pending_pairs(p_run uuid, p_slot integer, p_slots integer, p_limit integer)
returns table (a uuid, b uuid, cosine real, a_raw text, b_raw text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.a, p.b, p.cosine, ca.raw, cb.raw
  from public.kw_pairs p
  join public.kw_candidates ca on ca.id = p.a
  join public.kw_candidates cb on cb.id = p.b
  where p.map_run_id = p_run and p.verdict is null
    and p_slots >= 1 and (abs(hashtextextended(p.a::text || p.b::text, 0)) % p_slots) = p_slot
  order by p.cosine desc nulls last, p.a, p.b
  limit least(greatest(p_limit, 1), 200);
$$;

-- Judge budget guard: keeps the p_keep highest-cosine pending pairs, settles the rest as `related` (= stay separate).
create function public.kw_cap_pending(p_run uuid, p_keep integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  update public.kw_pairs p
  set verdict = 'related', judged_by = 'cap', reason = 'over the judge budget for this run: kept as separate articles'
  where p.map_run_id = p_run and p.verdict is null
    and (p.a, p.b) in (
      select q.a, q.b from public.kw_pairs q
      where q.map_run_id = p_run and q.verdict is null
      order by q.cosine desc nulls last, q.a, q.b
      offset greatest(p_keep, 0)
    );
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create function public.map_run_cost_usd(p_run uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(l.cost_usd), 0)
  from public.llm_calls l
  join public.jobs j on j.id = l.job_id
  where j.payload ->> 'mapRunId' = p_run::text;
$$;

-- ---------------------------------------------------------------------------
-- Privileges + RLS
-- ---------------------------------------------------------------------------
alter table public.projects       enable row level security;
alter table public.map_runs       enable row level security;
alter table public.facets         enable row level security;
alter table public.kw_candidates  enable row level security;
alter table public.kw_pairs       enable row level security;
alter table public.golden_pairs   enable row level security;

revoke all on public.projects, public.map_runs, public.facets, public.kw_candidates, public.kw_pairs, public.golden_pairs
  from public, anon, authenticated;
grant select on public.projects, public.map_runs, public.facets, public.kw_candidates, public.kw_pairs to authenticated;

create policy projects_select on public.projects for select to authenticated using (public.is_workspace_member(workspace_id));
create policy map_runs_select on public.map_runs for select to authenticated using (public.is_workspace_member(workspace_id));
create policy facets_select on public.facets for select to authenticated using (public.is_workspace_member(workspace_id));
create policy kw_candidates_select on public.kw_candidates for select to authenticated using (public.is_workspace_member(workspace_id));
create policy kw_pairs_select on public.kw_pairs for select to authenticated using (public.is_workspace_member(workspace_id));
-- golden_pairs: no policy, no grant: server only.

revoke all on function public.map_credit_cost(integer) from public, anon, authenticated;
revoke all on function public.map_runs_touch() from public, anon, authenticated;
revoke all on function public.map_run_create(uuid, uuid, text, text, text, integer, integer, text, text, uuid) from public, anon, authenticated;
revoke all on function public.map_run_finish(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.map_run_set_stage(uuid, text) from public, anon, authenticated;
revoke all on function public.map_stage_status(uuid, text) from public, anon, authenticated;
revoke all on function public.map_run_watchdog(integer) from public, anon, authenticated;
revoke all on function public.map_run_cancel(uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_map_run_create(uuid, uuid, text, text, text, integer, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.admin_map_run_list(integer) from public, anon, authenticated;

grant execute on function public.map_credit_cost(integer) to service_role;
grant execute on function public.map_run_create(uuid, uuid, text, text, text, integer, integer, text, text, uuid) to service_role;
grant execute on function public.map_run_finish(uuid, text, text, jsonb) to service_role;
grant execute on function public.map_run_set_stage(uuid, text) to service_role;
grant execute on function public.map_stage_status(uuid, text) to service_role;
grant execute on function public.map_run_watchdog(integer) to service_role;
grant execute on function public.map_run_cancel(uuid, uuid) to service_role;
grant execute on function public.admin_map_run_create(uuid, uuid, text, text, text, integer, integer, text, text, text) to service_role;
grant execute on function public.admin_map_run_list(integer) to service_role;

revoke all on function public.kw_apply_updates(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.kw_pending_pairs(uuid, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.kw_cap_pending(uuid, integer) from public, anon, authenticated;
revoke all on function public.map_run_cost_usd(uuid) from public, anon, authenticated;
grant execute on function public.kw_apply_updates(uuid, jsonb) to service_role;
grant execute on function public.kw_pending_pairs(uuid, integer, integer, integer) to service_role;
grant execute on function public.kw_cap_pending(uuid, integer) to service_role;
grant execute on function public.map_run_cost_usd(uuid) to service_role;
