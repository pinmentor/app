-- 0027_keyword_library.sql — Batch 24a: the user's own keywords. Requires 0001, 0006 (jobs), 0008 (maps), 0011 (sized maps), 0021 (sites).
--
--   * keyword_library : a workspace's saved keywords (pasted, uploaded as CSV, later from GSC/trends). Duplicates are
--     collapsed on norm_key (computed by the app with the same normaliser the map uses; the database only enforces uniqueness).
--     Rows are written ONLY by the functions below (service role); members can read their own.
--   * keywords_import / keywords_delete : member-only, called by the server with p_user.
--   * map_run_create_own : starts a map run with the user's own keywords.
--       p_only_mine = false  "Expand + mine": the normal run (S1 facets, S2 expansion) and the keywords join the candidates (source 'manual').
--       p_only_mine = true   "Only my keywords": S1-S2 are skipped (no model spend there); the run starts at S3 (normalise) with exactly
--                            these keywords; they must be at least 10.
--     MONEY: the credit hold uses the existing map_credit_cost() on the ceiling/size, exactly like any map. No new price is set here (B49 decides).
--   * admin_map_run_create_own : the superadmin entry point (own workspace only, writes admin_audit), same as the other admin_map_run_create_*.

create table public.keyword_library (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  site_id      uuid references public.sites (id) on delete set null,
  text         text not null check (char_length(text) between 1 and 200 and text = btrim(text)),
  norm_key     text not null check (char_length(norm_key) between 1 and 200),
  lang         text not null references public.languages (code),
  kind         text not null default 'keyword' check (kind in ('keyword', 'annotation')),
  source       text not null check (source in ('manual', 'csv', 'gsc', 'trend', 'suggested')),
  tags         text[] not null default '{}' check (cardinality(tags) <= 10),
  created_at   timestamptz not null default now(),
  unique (workspace_id, lang, kind, norm_key)
);
create index keyword_library_ws_idx on public.keyword_library (workspace_id, created_at desc);

alter table public.keyword_library enable row level security;
create policy keyword_library_select on public.keyword_library for select to authenticated using (public.is_workspace_member(workspace_id));
revoke all on public.keyword_library from public, anon, authenticated;
grant select on public.keyword_library to authenticated;
grant select, insert, update, delete on public.keyword_library to service_role;

-- ---------------------------------------------------------------------------
-- Import. p_items = [{"text": "...", "norm_key": "...", "tags": ["..."]}, ...] (at most 2000 per call).
-- Returns {"added": n, "duplicates": n, "invalid": n}. A workspace holds at most 5000 library rows (free-tier disk).
-- ---------------------------------------------------------------------------
create function public.keywords_import(p_user uuid, p_workspace uuid, p_lang text, p_kind text, p_source text, p_site uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total   integer;
  v_valid   integer;
  v_added   integer;
begin
  if not exists (select 1 from public.workspace_members m where m.workspace_id = p_workspace and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_lang is null or not exists (select 1 from public.languages l where l.code = p_lang) then
    raise exception 'bad_language' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('keyword', 'annotation') or p_source is null or p_source not in ('manual', 'csv', 'gsc', 'trend', 'suggested') then
    raise exception 'bad_kind' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 2000 then
    raise exception 'bad_items' using errcode = '22023';
  end if;
  if p_site is not null and not exists (select 1 from public.sites s where s.id = p_site and s.workspace_id = p_workspace) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_total := jsonb_array_length(p_items);

  create temp table pg_temp.kw_in on commit drop as
  select btrim(e ->> 'text') as text, btrim(e ->> 'norm_key') as norm_key,
         coalesce((select array_agg(distinct left(btrim(t), 40)) from jsonb_array_elements_text(
            case when jsonb_typeof(e -> 'tags') = 'array' then e -> 'tags' else '[]'::jsonb end) t where btrim(t) <> ''), '{}'::text[]) as tags
  from jsonb_array_elements(p_items) e
  where jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 'text') = 'string' and jsonb_typeof(e -> 'norm_key') = 'string';

  delete from pg_temp.kw_in
  where char_length(text) not between 1 and 200 or char_length(norm_key) not between 1 and 200 or cardinality(tags) > 10;
  select count(*) into v_valid from pg_temp.kw_in;

  with ins as (
    insert into public.keyword_library (workspace_id, site_id, text, norm_key, lang, kind, source, tags)
    select p_workspace, p_site, i.text, i.norm_key, p_lang, p_kind, p_source, i.tags from pg_temp.kw_in i
    on conflict (workspace_id, lang, kind, norm_key) do nothing
    returning 1
  )
  select count(*) into v_added from ins;

  if (select count(*) from public.keyword_library where workspace_id = p_workspace) > 5000 then
    raise exception 'library_full' using errcode = '54000';
  end if;
  return jsonb_build_object('added', v_added, 'duplicates', v_valid - v_added, 'invalid', v_total - v_valid);
end;
$$;

create function public.keywords_delete(p_user uuid, p_workspace uuid, p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if not exists (select 1 from public.workspace_members m where m.workspace_id = p_workspace and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_ids is null or cardinality(p_ids) not between 1 and 1000 then
    raise exception 'bad_ids' using errcode = '22023';
  end if;
  delete from public.keyword_library where workspace_id = p_workspace and id = any (p_ids);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- A map run with the user's own keywords (see header). p_keywords = ["peinados faciles", ...] (1..1000, each 1..200 characters).
-- Idempotent on p_key: a replay returns the same run and adds nothing.
-- ---------------------------------------------------------------------------
create function public.map_run_create_own(
  p_workspace  uuid,
  p_user       uuid,
  p_topic      text,
  p_language   text,
  p_locale     text,
  p_only_mine  boolean,
  p_size       text,
  p_target_min integer,
  p_target_max integer,
  p_mode       text,
  p_key        text,
  p_keywords   jsonb,
  p_project    uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing uuid;
  v_id       uuid;
  v_kw       text[];
  v_n        integer;
begin
  if p_keywords is null or jsonb_typeof(p_keywords) <> 'array' or jsonb_array_length(p_keywords) not between 1 and 1000 then
    raise exception 'bad_keywords' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_keywords) e where jsonb_typeof(e) <> 'string') then
    raise exception 'bad_keywords' using errcode = '22023';
  end if;
  -- clean: trim, drop empty or over-long, collapse exact (case-insensitive) repeats; the first spelling wins
  select coalesce(array_agg(t order by ord), '{}'::text[]) into v_kw from (
    select distinct on (lower(btrim(e.value))) btrim(e.value) as t, e.ord
    from jsonb_array_elements_text(p_keywords) with ordinality as e(value, ord)
    where char_length(btrim(e.value)) between 1 and 200
    order by lower(btrim(e.value)), e.ord
  ) q;
  v_n := cardinality(v_kw);
  if v_n < 1 or (p_only_mine and v_n < 10) then
    raise exception 'need_more_keywords' using errcode = '22023';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = p_workspace and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select r.id into v_existing from public.map_runs r
  where r.workspace_id = p_workspace and r.params ->> 'idempotency_key' = p_key;
  if found then
    return v_existing;   -- replay: nothing is added or changed
  end if;

  if p_only_mine then
    v_id := public.map_run_create(p_workspace, p_user, p_topic, p_language, p_locale, 10, least(1000, greatest(10, v_n)), p_mode, p_key, p_project);
    -- skip S1-S2: the run starts at S3 with exactly these keywords
    update public.jobs set state = 'canceled', finished_at = now(), locked_by = null, lease_expires_at = null
    where idempotency_key = 'map:' || v_id::text || ':s1' and state = 'queued';
    update public.map_runs
    set stage = 's3_normalize', params = params || jsonb_build_object('size', 'custom', 'ceiling', target_max, 'own_only', true, 'own_count', v_n)
    where id = v_id;
  else
    v_id := public.map_run_create_sized(p_workspace, p_user, p_topic, p_language, p_locale, p_size, p_target_min, p_target_max, p_mode, p_key, p_project);
    update public.map_runs set params = params || jsonb_build_object('own_count', v_n) where id = v_id;
  end if;

  insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source)
  select p_workspace, v_id, k, lower(btrim(k)), p_language, 'manual' from unnest(v_kw) as k
  on conflict (map_run_id, raw_key) do nothing;

  if p_only_mine then
    perform public.job_enqueue(p_workspace, 'map.s3_normalize', jsonb_build_object('mapRunId', v_id),
                               'map:' || v_id::text || ':s3', null, now(), 3, 0, null, null, 's3_normalize');
  end if;
  return v_id;
end;
$$;

create function public.admin_map_run_create_own(
  p_admin      uuid,
  p_workspace  uuid,
  p_topic      text,
  p_language   text,
  p_locale     text,
  p_only_mine  boolean,
  p_size       text,
  p_target_min integer,
  p_target_max integer,
  p_mode       text,
  p_key        text,
  p_keywords   jsonb,
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
  v_id := public.map_run_create_own(p_workspace, p_admin, p_topic, p_language, p_locale, p_only_mine, p_size, p_target_min, p_target_max, p_mode, 'admin:' || p_key, p_keywords);

  if not v_existed then
    insert into public.admin_audit (admin_id, action, target_type, target_id, diff, ip)
    values (p_admin, 'map_run_create', 'map_run', v_id::text,
            jsonb_build_object('workspace_id', p_workspace, 'own_keywords', jsonb_array_length(p_keywords), 'only_mine', p_only_mine,
                               'size', p_size, 'target_max', p_target_max, 'mode', p_mode, 'credits', public.map_credit_cost(p_target_max)), p_ip);
  end if;
  return v_id;
end;
$$;

revoke all on function public.keywords_import(uuid, uuid, text, text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.keywords_delete(uuid, uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.map_run_create_own(uuid, uuid, text, text, text, boolean, text, integer, integer, text, text, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.admin_map_run_create_own(uuid, uuid, text, text, text, boolean, text, integer, integer, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.keywords_import(uuid, uuid, text, text, text, uuid, jsonb) to service_role;
grant execute on function public.keywords_delete(uuid, uuid, uuid[]) to service_role;
grant execute on function public.map_run_create_own(uuid, uuid, text, text, text, boolean, text, integer, integer, text, text, jsonb, uuid) to service_role;
grant execute on function public.admin_map_run_create_own(uuid, uuid, text, text, text, boolean, text, integer, integer, text, text, jsonb, text) to service_role;
