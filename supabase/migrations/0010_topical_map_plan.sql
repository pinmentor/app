-- 0010_topical_map_plan.sql
-- PinMentor Batch 06: S5-S9 of the topical map (intent/type, scoring, silos, titles/slugs/links, verification report).
-- Requires 0008 + 0009. Paste into Supabase SQL Editor and run ONCE, then run supabase/tests/rls_0010.sql.
--
-- Tables: silos, plan_items, map_snapshots (members select-only; every write goes through the server).
-- `batches` / `batch_items` belong to the writing-workflow batch and are NOT created here.

-- ---------------------------------------------------------------------------
-- kw_candidates: S5 outputs that have no column yet
-- ---------------------------------------------------------------------------
alter table public.kw_candidates
  add column pinterest_fit smallint check (pinterest_fit between 1 and 5),
  add column seasonality   smallint check (seasonality between 0 and 2);   -- 0 none, 1 mild, 2 strong

alter table public.kw_candidates
  add constraint kw_candidates_intent_chk
    check (intent is null or intent in ('informational', 'commercial_investigation', 'transactional', 'navigational')),
  add constraint kw_candidates_funnel_chk
    check (funnel is null or funnel in ('awareness', 'consideration', 'decision'));

-- 0009 re-granted SELECT column by column (the vector stays hidden): the new columns need the same grant.
grant select (pinterest_fit, seasonality) on public.kw_candidates to authenticated;

-- ---------------------------------------------------------------------------
-- Routes for the two new LLM tasks (cheap class, like the other generation tasks)
-- ---------------------------------------------------------------------------
insert into public.llm_routes (task, model_keys, description) values
  ('intent_classification', array['anthropic.haiku-5-5','gemini.3-5-flash-lite','openai.gpt-6-luna'], 'cheap: intent / funnel / pinterest fit per keyword (S5)'),
  ('silo_naming',           array['anthropic.haiku-5-5','gemini.3-5-flash-lite','openai.gpt-6-luna'], 'cheap: silo names (S6)');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.silos (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  project_id     uuid not null references public.projects (id) on delete cascade,
  map_run_id     uuid not null references public.map_runs (id) on delete cascade,
  name           text not null check (char_length(name) between 1 and 120),
  gloss          jsonb not null default '{}'::jsonb,       -- {"en": "...", "bn": "..."} for non-Spanish readers (PLAN §3.13)
  pillar_item_id uuid,                                      -- FK below (plan_items does not exist yet)
  parent_silo_id uuid references public.silos (id) on delete set null,
  position       integer not null default 0,
  size           integer not null default 0 check (size >= 0),
  created_at     timestamptz not null default now()
);
create index silos_run_idx on public.silos (map_run_id, position);
create index silos_project_idx on public.silos (project_id);

create table public.plan_items (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  project_id    uuid not null references public.projects (id) on delete cascade,
  map_run_id    uuid not null references public.map_runs (id) on delete cascade,
  silo_id       uuid references public.silos (id) on delete set null,
  primary_kw_id uuid not null references public.kw_candidates (id) on delete cascade,
  keyword       text not null,                              -- the primary keyword text (denormalised for the review table)
  variants      text[] not null default '{}',               -- merged keywords live here, never as separate items
  title         text,
  title_options jsonb not null default '[]'::jsonb,
  slug          text check (slug is null or slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  article_type  text not null check (article_type in ('A', 'B')),
  list_count    integer check (list_count is null or list_count between 3 and 100),
  target_words  integer not null default 1500 check (target_words between 300 and 6000),
  decision      text not null default 'separate' check (decision in ('separate', 'section_of_parent')),
  status        text not null default 'draft' check (status in ('draft', 'approved', 'rejected')),
  intent        text,
  funnel        text,
  priority      numeric not null default 0,
  score_detail  jsonb not null default '{}'::jsonb,
  link_plan     jsonb not null default '{}'::jsonb,
  gloss         jsonb not null default '{}'::jsonb,
  flags         text[] not null default '{}',
  position      integer not null default 0,
  created_at    timestamptz not null default now(),
  unique (map_run_id, primary_kw_id),
  unique (map_run_id, slug)
);
create index plan_items_run_idx on public.plan_items (map_run_id, position);
create index plan_items_silo_idx on public.plan_items (silo_id);
create index plan_items_project_idx on public.plan_items (project_id);

alter table public.silos
  add constraint silos_pillar_fk foreign key (pillar_item_id) references public.plan_items (id) on delete set null;

create table public.map_snapshots (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id   uuid not null references public.projects (id) on delete cascade,
  map_run_id   uuid references public.map_runs (id) on delete set null,
  version      integer not null check (version >= 1),
  summary      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  unique (project_id, version)
);

-- ---------------------------------------------------------------------------
-- RLS: members read their workspace's rows; nobody but the server writes
-- ---------------------------------------------------------------------------
alter table public.silos enable row level security;
alter table public.plan_items enable row level security;
alter table public.map_snapshots enable row level security;

revoke all on public.silos, public.plan_items, public.map_snapshots from public, anon, authenticated;
grant select on public.silos, public.plan_items, public.map_snapshots to authenticated;

create policy silos_select on public.silos for select to authenticated using (public.is_workspace_member(workspace_id));
create policy plan_items_select on public.plan_items for select to authenticated using (public.is_workspace_member(workspace_id));
create policy map_snapshots_select on public.map_snapshots for select to authenticated using (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Server functions (service_role only)
-- ---------------------------------------------------------------------------

-- S5: writes the classification of a batch of primaries. p_items = [{id, intent, funnel, demand_tier, pinterest_fit,
-- seasonality, flags:[..]}]. demand_source is always 'estimate': it is an LLM signal, never a search volume (PLAN §3.7).
create function public.kw_apply_classification(p_run uuid, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) > 500 then
    raise exception 'invalid_items' using errcode = '22023';
  end if;
  update public.kw_candidates c
  set intent        = coalesce(i.intent, c.intent),
      funnel        = coalesce(i.funnel, c.funnel),
      demand_tier   = coalesce(i.demand_tier, c.demand_tier),
      demand_source = case when i.demand_tier is not null then 'estimate' else c.demand_source end,
      pinterest_fit = coalesce(i.pinterest_fit, c.pinterest_fit),
      seasonality   = coalesce(i.seasonality, c.seasonality),
      priority      = coalesce(i.priority, c.priority),
      flags         = case when i.flags is null then c.flags
                           else (select coalesce(array_agg(distinct f order by f), '{}') from unnest(c.flags || i.flags) f) end
  from jsonb_to_recordset(p_items) as i(id uuid, intent text, funnel text, demand_tier smallint, pinterest_fit smallint,
                                        seasonality smallint, priority numeric, flags text[])
  where c.id = i.id and c.map_run_id = p_run;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- S6: for every primary of a run, its nearest primary neighbours (cosine >= p_min, at most p_k per item), as a flat list
-- ordered by (a, cosine desc, b) so the caller can page with p_offset / p_limit. A pair appears once per side; the caller
-- folds both directions. Brute force over one run's primaries (a few hundred rows).
create function public.kw_primary_edges(p_run uuid, p_min real, p_k integer, p_offset integer, p_limit integer)
returns table (a uuid, b uuid, cosine real)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_k < 1 or p_k > 50 or p_limit < 1 or p_limit > 1000 or p_offset < 0 then
    raise exception 'invalid_paging' using errcode = '22023';
  end if;
  return query
  select x.id, nb.id, nb.cos
  from public.kw_candidates x
  cross join lateral (
    select y.id, (1 - (x.embedding operator(extensions.<=>) y.embedding))::real as cos
    from public.kw_candidates y
    where y.map_run_id = p_run and y.status = 'primary' and y.id <> x.id and y.embedding is not null
      and (1 - (x.embedding operator(extensions.<=>) y.embedding)) >= p_min
    order by 2 desc, y.id
    limit p_k
  ) nb
  where x.map_run_id = p_run and x.status = 'primary' and x.embedding is not null
  order by 1, 3 desc, 2
  offset p_offset limit p_limit;
end;
$$;

-- Adds keys to map_runs.stats (stats of S4 stay when S5-S9 add theirs).
create function public.map_run_merge_stats(p_run uuid, p_stats jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.map_runs set stats = stats || coalesce(p_stats, '{}'::jsonb)
  where id = p_run and status in ('queued', 'running');
$$;

create function public.map_run_set_report(p_run uuid, p_report jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.map_runs set report = p_report where id = p_run and status in ('queued', 'running');
$$;

-- Idempotent S6: a retried job rebuilds the plan from scratch (silos first: plan_items.silo_id is set null on delete).
create function public.map_plan_reset(p_run uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.plan_items where map_run_id = p_run;
  delete from public.silos where map_run_id = p_run;
$$;

-- Batch update of plan items (titles, glosses, slugs, link plans, flags). p_items = [{id, title, title_options, gloss,
-- slug, link_plan, status, flags}]; a missing key keeps the current value.
create function public.plan_items_apply(p_run uuid, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) > 500 then
    raise exception 'invalid_items' using errcode = '22023';
  end if;
  update public.plan_items p
  set title         = coalesce(i.title, p.title),
      title_options = coalesce(i.title_options, p.title_options),
      gloss         = coalesce(i.gloss, p.gloss),
      slug          = coalesce(i.slug, p.slug),
      link_plan     = coalesce(i.link_plan, p.link_plan),
      status        = coalesce(i.status, p.status),
      flags         = case when i.flags is null then p.flags
                           else (select coalesce(array_agg(distinct f order by f), '{}') from unnest(p.flags || i.flags) f) end
  from jsonb_to_recordset(p_items) as i(id uuid, title text, title_options jsonb, gloss jsonb, slug text, link_plan jsonb, status text, flags text[])
  where p.id = i.id and p.map_run_id = p_run;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Version snapshot of a finished plan (PLAN §3.12). Version = next number of the project; idempotent per run.
create function public.map_snapshot_create(p_run uuid, p_summary jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.map_runs;
  v_version integer;
begin
  select * into r from public.map_runs where id = p_run;
  if not found then
    raise exception 'map_run_not_found' using errcode = 'PM004';
  end if;
  select version into v_version from public.map_snapshots where map_run_id = p_run order by version desc limit 1;
  if found then
    return v_version;   -- a retried finish does not add a second snapshot
  end if;
  select coalesce(max(version), 0) + 1 into v_version from public.map_snapshots where project_id = r.project_id;
  insert into public.map_snapshots (workspace_id, project_id, map_run_id, version, summary)
  values (r.workspace_id, r.project_id, p_run, v_version, coalesce(p_summary, '{}'::jsonb));
  return v_version;
end;
$$;

revoke all on function public.kw_apply_classification(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.kw_primary_edges(uuid, real, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.map_run_merge_stats(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.map_run_set_report(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.map_plan_reset(uuid) from public, anon, authenticated;
revoke all on function public.plan_items_apply(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.map_snapshot_create(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.kw_apply_classification(uuid, jsonb) to service_role;
grant execute on function public.kw_primary_edges(uuid, real, integer, integer, integer) to service_role;
grant execute on function public.map_run_merge_stats(uuid, jsonb) to service_role;
grant execute on function public.map_run_set_report(uuid, jsonb) to service_role;
grant execute on function public.map_plan_reset(uuid) to service_role;
grant execute on function public.plan_items_apply(uuid, jsonb) to service_role;
grant execute on function public.map_snapshot_create(uuid, jsonb) to service_role;
