-- 0030_site_contents.sql — Batch 25. Requires 0006 (jobs), 0021 (sites), 0026 (site columns).
--
--   * site_contents : what a website already has (url, title, h1, headings, meta description, ...). Only headings and meta,
--     never the full HTML (free-tier disk). One row per (site, url_key). Members may read; only the server writes.
--   * sites.content_sync_* : state of the last sync (idle / running / done / failed) and progress counters.
--   * site_content_sync_start(p_user, p_site, p_mode, p_urls) : member-only; enqueues the first `site.sync` job.
--   * site_content_discover / site_content_save_page / site_content_progress / site_content_prune : called by the sync job
--     (service role only); they trust the job, not a user, and only ever touch the given site.
--   * site_content_clear(p_user, p_site) : member-only; removes the stored rows of a site.

create table public.site_contents (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  site_id          uuid not null references public.sites (id) on delete cascade,
  url              text not null check (char_length(url) between 10 and 500),
  url_key          text not null check (char_length(url_key) between 3 and 500),
  title            text check (title is null or char_length(title) <= 300),
  h1               text check (h1 is null or char_length(h1) <= 300),
  headings         text[] not null default '{}' check (cardinality(headings) <= 40),
  meta_description text check (meta_description is null or char_length(meta_description) <= 500),
  category         text check (category is null or char_length(category) <= 120),
  published_at     timestamptz,
  word_count       integer check (word_count is null or word_count >= 0),
  image_urls       text[] not null default '{}' check (cardinality(image_urls) <= 8),
  source           text not null check (source in ('sitemap', 'rss', 'wp', 'manual')),
  content_hash     text check (content_hash is null or char_length(content_hash) <= 80),
  fetched_at       timestamptz,
  last_synced      timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  unique (site_id, url_key)
);
create index site_contents_site_idx on public.site_contents (site_id);
create index site_contents_pending_idx on public.site_contents (site_id) where fetched_at is null;

alter table public.site_contents enable row level security;
create policy site_contents_select on public.site_contents for select to authenticated using (public.is_workspace_member(workspace_id));
revoke all on public.site_contents from public, anon, authenticated;
grant select on public.site_contents to authenticated;
grant select, insert, update, delete on public.site_contents to service_role;

alter table public.sites
  add column content_sync_state text not null default 'idle' check (content_sync_state in ('idle', 'running', 'done', 'failed')),
  add column content_sync_started_at timestamptz,
  add column content_synced_at timestamptz,
  add column content_sync_error text check (content_sync_error is null or char_length(content_sync_error) <= 120),
  add column content_sync_total integer not null default 0,
  add column content_sync_done integer not null default 0;
grant select (content_sync_state, content_sync_started_at, content_synced_at, content_sync_error, content_sync_total, content_sync_done) on public.sites to authenticated;

-- Start a sync. p_mode: 'auto' (WordPress REST, else sitemap, else RSS) or 'urls' (p_urls = a list of page addresses, max 500).
create function public.site_content_sync_start(p_user uuid, p_site uuid, p_mode text, p_urls jsonb default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  s     public.sites;
  v_n   integer;
  v_job uuid;
begin
  select * into s from public.sites where id = p_site;
  if not found then raise exception 'site_not_found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = s.workspace_id and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_mode not in ('auto', 'urls') then raise exception 'bad_mode' using errcode = '22023'; end if;
  if p_mode = 'urls' and (p_urls is null or jsonb_typeof(p_urls) <> 'array' or jsonb_array_length(p_urls) not between 1 and 500) then
    raise exception 'bad_urls' using errcode = '22023';
  end if;
  if s.content_sync_state = 'running' and s.content_sync_started_at > now() - interval '30 minutes' then
    raise exception 'sync_running' using errcode = 'PM007';
  end if;
  select count(*) into v_n from public.jobs where left(idempotency_key, length('site.sync:' || p_site::text || ':')) = 'site.sync:' || p_site::text || ':';
  update public.sites set content_sync_state = 'running', content_sync_started_at = now(), content_sync_error = null, content_sync_total = 0, content_sync_done = 0 where id = p_site;
  v_job := public.job_enqueue(s.workspace_id, 'site.sync',
             jsonb_build_object('siteId', p_site, 'userId', p_user, 'mode', p_mode, 'step', 'discover', 'page', 1, 'startedAt', now(), 'urls', case when p_mode = 'urls' then p_urls else null end),
             'site.sync:' || p_site::text || ':' || v_n::text, null, now(), 3, 0, null, null, 'discover');
  return v_job;
end;
$$;

-- Job side: add discovered addresses (no page data yet). Existing rows keep their data; only last_synced moves.
-- p_items = [{url, url_key, title?, published_at?, meta_description?, category?}] (title etc. come from WP REST / RSS and mark the row fetched).
create function public.site_content_discover(p_site uuid, p_source text, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.sites;
  v_n integer;
begin
  select * into s from public.sites where id = p_site;
  if not found then raise exception 'site_not_found' using errcode = 'P0002'; end if;
  if p_source not in ('sitemap', 'rss', 'wp', 'manual') then raise exception 'bad_source' using errcode = '22023'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 1000 then raise exception 'bad_items' using errcode = '22023'; end if;

  with src as (
    select distinct on (left(btrim(i.url_key), 500))
           left(btrim(i.url), 500) as url, left(btrim(i.url_key), 500) as url_key, left(nullif(btrim(i.title), ''), 300) as title,
           i.published_at, left(nullif(btrim(i.meta_description), ''), 500) as meta, left(nullif(btrim(i.category), ''), 120) as category
    from jsonb_to_recordset(p_items) as i(url text, url_key text, title text, published_at timestamptz, meta_description text, category text)
    where i.url ~ '^https://' and char_length(btrim(i.url)) between 10 and 500 and char_length(btrim(i.url_key)) between 3 and 500
  ), ins as (
    insert into public.site_contents (workspace_id, site_id, url, url_key, title, published_at, meta_description, category, source, fetched_at)
    select s.workspace_id, p_site, url, url_key, title, published_at, meta, category, p_source, case when title is not null then now() end from src
    on conflict (site_id, url_key) do update
      set last_synced = now(),
          title = coalesce(excluded.title, public.site_contents.title),
          published_at = coalesce(excluded.published_at, public.site_contents.published_at),
          meta_description = coalesce(excluded.meta_description, public.site_contents.meta_description),
          category = coalesce(excluded.category, public.site_contents.category),
          fetched_at = coalesce(public.site_contents.fetched_at, excluded.fetched_at)
    returning 1
  )
  select count(*) into v_n from ins;
  return v_n;
end;
$$;

-- Job side: the data read from one page. A page that could not be read is marked fetched (fetched_at set) so it is not retried forever.
-- p_page = {url_key, title, h1, headings[], meta_description, published_at, word_count, image_urls[], content_hash, ok}
create function public.site_content_save_page(p_site uuid, p_page jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := left(btrim(coalesce(p_page ->> 'url_key', '')), 500);
begin
  if not exists (select 1 from public.sites where id = p_site) then raise exception 'site_not_found' using errcode = 'P0002'; end if;
  update public.site_contents c set
    title = case when coalesce((p_page ->> 'ok')::boolean, false) then left(nullif(btrim(p_page ->> 'title'), ''), 300) else c.title end,
    h1 = case when coalesce((p_page ->> 'ok')::boolean, false) then left(nullif(btrim(p_page ->> 'h1'), ''), 300) else c.h1 end,
    headings = case when coalesce((p_page ->> 'ok')::boolean, false) then coalesce((select array_agg(left(h, 200)) from (select jsonb_array_elements_text(p_page -> 'headings') as h limit 40) x), '{}') else c.headings end,
    meta_description = case when coalesce((p_page ->> 'ok')::boolean, false) then left(nullif(btrim(p_page ->> 'meta_description'), ''), 500) else c.meta_description end,
    published_at = coalesce(nullif(p_page ->> 'published_at', '')::timestamptz, c.published_at),
    word_count = case when coalesce((p_page ->> 'ok')::boolean, false) then nullif(p_page ->> 'word_count', '')::integer else c.word_count end,
    image_urls = case when coalesce((p_page ->> 'ok')::boolean, false) then coalesce((select array_agg(left(u, 500)) from (select jsonb_array_elements_text(p_page -> 'image_urls') as u limit 8) y where u ~ '^https://'), '{}') else c.image_urls end,
    content_hash = left(p_page ->> 'content_hash', 80),
    fetched_at = now(), last_synced = now()
  where c.site_id = p_site and c.url_key = v_key;
end;
$$;

-- Job side: progress and the end state. p_state 'running' recounts total/done from the rows themselves.
create function public.site_content_progress(p_site uuid, p_state text, p_error text default null)
returns table (total integer, done integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer;
  v_done  integer;
begin
  if p_state not in ('running', 'done', 'failed') then raise exception 'bad_state' using errcode = '22023'; end if;
  select count(*)::integer, (count(*) filter (where fetched_at is not null))::integer into v_total, v_done from public.site_contents where site_id = p_site;
  update public.sites set
    content_sync_state = p_state, content_sync_total = v_total, content_sync_done = v_done,
    content_sync_error = case when p_state = 'failed' then left(p_error, 120) else null end,
    content_synced_at = case when p_state = 'done' then now() else content_synced_at end
  where id = p_site;
  if not found then raise exception 'site_not_found' using errcode = 'P0002'; end if;
  return query select v_total, v_done;
end;
$$;

-- Job side: after a complete discovery, rows of the discovered sources that the sync did not see any more are removed.
create function public.site_content_prune(p_site uuid, p_before timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_n integer;
begin
  delete from public.site_contents where site_id = p_site and source in ('sitemap', 'rss', 'wp') and last_synced < p_before;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create function public.site_content_clear(p_user uuid, p_site uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.sites;
  v_n integer;
begin
  select * into s from public.sites where id = p_site;
  if not found then raise exception 'site_not_found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = s.workspace_id and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.site_contents where site_id = p_site;
  get diagnostics v_n = row_count;
  update public.sites set content_sync_state = 'idle', content_sync_total = 0, content_sync_done = 0, content_sync_error = null, content_synced_at = null where id = p_site;
  return v_n;
end;
$$;

revoke all on function public.site_content_sync_start(uuid, uuid, text, jsonb), public.site_content_discover(uuid, text, jsonb), public.site_content_save_page(uuid, jsonb),
  public.site_content_progress(uuid, text, text), public.site_content_prune(uuid, timestamptz), public.site_content_clear(uuid, uuid) from public, anon, authenticated;
grant execute on function public.site_content_sync_start(uuid, uuid, text, jsonb), public.site_content_discover(uuid, text, jsonb), public.site_content_save_page(uuid, jsonb),
  public.site_content_progress(uuid, text, text), public.site_content_prune(uuid, timestamptz), public.site_content_clear(uuid, uuid) to service_role;

-- V6 (B25): a map item that the site already covers. plan_items_mark_existing is called by the verify stage (service role).
-- p_marks = [{id, kind: 'same' | 'close', url, title}]. 'same' sets the status to already_exists, but only for an item still
-- `proposed` and not the main article (pillar) of its group; 'close' and every mark add a flag and the address of the page.
alter table public.plan_items
  add column existing_url   text check (existing_url is null or char_length(existing_url) <= 500),
  add column existing_title text check (existing_title is null or char_length(existing_title) <= 300);

create function public.plan_items_mark_existing(p_run uuid, p_marks jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_n integer;
begin
  if not exists (select 1 from public.map_runs where id = p_run) then raise exception 'map_run_not_found' using errcode = 'PM004'; end if;
  if p_marks is null or jsonb_typeof(p_marks) <> 'array' or jsonb_array_length(p_marks) > 1000 then raise exception 'bad_marks' using errcode = '22023'; end if;
  with m as (
    select (x.id)::uuid as id, x.kind, left(x.url, 500) as url, left(x.title, 300) as title
    from jsonb_to_recordset(p_marks) as x(id text, kind text, url text, title text)
    where x.kind in ('same', 'close') and x.url ~ '^https://'
  ), up as (
    update public.plan_items i set
      flags = case when m.kind = 'same' then (select array_agg(distinct f) from unnest(i.flags || array['exists_on_site']) f)
                   else (select array_agg(distinct f) from unnest(i.flags || array['similar_on_site']) f) end,
      existing_url = m.url,
      existing_title = m.title,
      status = case when m.kind = 'same' and i.status = 'proposed'
                         and not exists (select 1 from public.silos s where s.pillar_item_id = i.id) then 'already_exists' else i.status end
    from m
    where i.id = m.id and i.map_run_id = p_run
    returning 1
  )
  select count(*) into v_n from up;
  return v_n;
end;
$$;
revoke all on function public.plan_items_mark_existing(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.plan_items_mark_existing(uuid, jsonb) to service_role;
