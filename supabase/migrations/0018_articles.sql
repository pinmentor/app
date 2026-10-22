-- 0018_articles.sql — Batch 12, part 2: articles, the batch run (credit hold), per-article cost. Requires 0015-0017.
--
-- Flow: a `planned` batch is started (batch_run_start): one `articles` row + one job per item, items -> `writing`, the
-- credits are HELD (rate x articles). Each article is written by chained jobs (outline -> sections -> assemble, in the
-- app). When every article of the batch is final, batch_settle_if_done releases the hold and commits the price of the
-- articles that really came out `ready` only (a failed or cancelled article costs the user nothing).
--
-- PRICE: credit_rates.article_write = credits PER ARTICLE, set by a superadmin on /admin/credits (0017). It is NOT set
-- here. While it is missing, batch_run_start refuses with PM005 (rate_not_set). A rate of 0 is allowed (free test run).
-- Error codes: PM001 insufficient credits (ledger), PM003 invalid state, PM004 not found, PM005 rate not set.
--
-- Rules enforced HERE (the app calls through the service role after authenticating the user):
--   * caller is a member of the batch's workspace (42501); batch missing = PM004;
--   * only a `planned` batch with at least one in_batch item can start (PM003); every item must be Type A with a title
--     (Type B and untitled split items are refused with PM003);
--   * a replay of batch_run_start on a batch that already runs returns the article count, spends nothing twice.

alter table public.batches
  add column credit_rate      integer check (credit_rate is null or credit_rate >= 0),
  add column credit_amount    integer not null default 0 check (credit_amount >= 0),
  add column credit_ledger_id uuid,
  add column started_at       timestamptz,
  add column finished_at      timestamptz,
  add column stats            jsonb not null default '{}'::jsonb;

create table public.articles (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  project_id    uuid not null references public.projects (id) on delete cascade,
  map_run_id    uuid not null references public.map_runs (id) on delete cascade,
  batch_id      uuid not null references public.batches (id),
  plan_item_id  uuid not null references public.plan_items (id) on delete cascade,
  keyword       text not null,
  locale        text not null,
  status        text not null default 'queued' check (status in ('queued', 'writing', 'ready', 'failed', 'canceled')),
  title         text,
  slug          text,
  outline       jsonb not null default '{}'::jsonb,
  body_html     text,
  word_count    integer check (word_count is null or word_count >= 0),
  qa            jsonb not null default '{}'::jsonb,
  stats         jsonb not null default '{}'::jsonb,
  last_error    text check (last_error is null or char_length(last_error) <= 300),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index articles_batch_idx on public.articles (batch_id);
create index articles_run_idx on public.articles (map_run_id);
create index articles_workspace_idx on public.articles (workspace_id);
-- one live article per plan item; a failed or cancelled one stays as history and the item can be written again
create unique index articles_item_live_idx on public.articles (plan_item_id) where status in ('queued', 'writing', 'ready');

create table public.article_sections (
  article_id   uuid not null references public.articles (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind         text not null check (kind in ('intro', 'item', 'faq', 'conclusion')),
  idx          integer not null check (idx >= 0),
  content      jsonb not null,
  words        integer not null default 0 check (words >= 0),
  created_at   timestamptz not null default now(),
  primary key (article_id, kind, idx)
);
create index article_sections_workspace_idx on public.article_sections (workspace_id);

create function public.articles_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger articles_touch_trg before update on public.articles for each row execute function public.articles_touch();

alter table public.articles enable row level security;
alter table public.article_sections enable row level security;
revoke all on public.articles, public.article_sections from public, anon, authenticated;
grant select on public.articles, public.article_sections to authenticated;
create policy articles_select on public.articles for select to authenticated using (public.is_workspace_member(workspace_id));
create policy article_sections_select on public.article_sections for select to authenticated using (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Start a batch: hold credits, create articles, enqueue the first job of each
-- ---------------------------------------------------------------------------
create function public.batch_run_start(p_user uuid, p_batch uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v        public.batches;
  v_rate   integer;
  v_n      integer;
  v_amount integer;
  v_ledger uuid;
  i        record;
  v_art    uuid;
begin
  v := public.batch_edit_guard(p_user, p_batch);
  if v.status = 'running' then
    return (select count(*)::integer from public.articles where batch_id = v.id);   -- replay
  end if;
  if v.status <> 'planned' then
    raise exception 'batch_not_planned' using errcode = 'PM003';
  end if;
  select count(*) into v_n from public.plan_items where batch_id = v.id and status = 'in_batch';
  if v_n = 0 then
    raise exception 'empty_batch' using errcode = 'PM003';
  end if;
  if exists (select 1 from public.plan_items where batch_id = v.id and status = 'in_batch' and article_type <> 'A') then
    raise exception 'type_b_not_supported' using errcode = 'PM003';
  end if;
  if exists (select 1 from public.plan_items where batch_id = v.id and status = 'in_batch' and (title is null or btrim(title) = '')) then
    raise exception 'item_needs_title' using errcode = 'PM003';
  end if;
  select r.credits into v_rate from public.credit_rates r where r.action = 'article_write';
  if not found then
    raise exception 'rate_not_set' using errcode = 'PM005';
  end if;

  v_amount := v_rate * v_n;
  if v_amount > 0 then
    v_ledger := public.credit_reserve(v.workspace_id, v_amount, 'batch_run', 'batch-run-reserve:' || v.id::text, 'batch', v.id::text);
  end if;
  update public.batches
  set status = 'running', credit_rate = v_rate, credit_amount = v_amount, credit_ledger_id = v_ledger, credit_estimate = v_amount, started_at = now()
  where id = v.id;

  for i in select pi.id, pi.keyword, pi.project_id, pi.map_run_id, mr.locale
           from public.plan_items pi join public.map_runs mr on mr.id = pi.map_run_id
           where pi.batch_id = v.id and pi.status = 'in_batch' order by pi.position, pi.id loop
    insert into public.articles (workspace_id, project_id, map_run_id, batch_id, plan_item_id, keyword, locale)
    values (v.workspace_id, i.project_id, i.map_run_id, v.id, i.id, i.keyword, i.locale)
    returning id into v_art;
    update public.plan_items set status = 'writing' where id = i.id;
    perform public.job_enqueue(v.workspace_id, 'article.outline', jsonb_build_object('articleId', v_art),
                               'article:' || v_art::text || ':outline', null, now(), 3, 0, null, null, 'outline');
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Finish one article (ready / failed / canceled) and settle the batch when it was the last one
-- p_patch (ready): {"title","slug","body_html","word_count","qa","stats"}; any key may be missing.
-- ---------------------------------------------------------------------------
create function public.article_finish(p_article uuid, p_status text, p_error text default null, p_patch jsonb default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.articles;
  p jsonb := coalesce(p_patch, '{}'::jsonb);
begin
  if p_status not in ('ready', 'failed', 'canceled') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  select * into a from public.articles where id = p_article for update;
  if not found then
    raise exception 'article_not_found' using errcode = 'PM004';
  end if;
  if a.status in ('ready', 'failed', 'canceled') then
    return a.status;   -- already final
  end if;

  update public.articles
  set status = p_status,
      last_error = case when p_status = 'ready' then null else left(p_error, 300) end,
      title = coalesce(p ->> 'title', title),
      slug = coalesce(p ->> 'slug', slug),
      body_html = coalesce(p ->> 'body_html', body_html),
      word_count = coalesce((p ->> 'word_count')::integer, word_count),
      qa = coalesce(p -> 'qa', qa),
      stats = stats || coalesce(p -> 'stats', '{}'::jsonb)
  where id = a.id;

  if p_status = 'ready' then
    update public.plan_items set status = 'draft_ready' where id = a.plan_item_id and status = 'writing';
  else
    -- not written: the item is free again (approved, no batch) and can go into another batch
    update public.plan_items set status = 'approved', batch_id = null where id = a.plan_item_id and status = 'writing';
    update public.jobs set state = 'canceled', finished_at = now(), locked_by = null, lease_expires_at = null
    where state = 'queued' and type like 'article.%' and payload ->> 'articleId' = a.id::text;
  end if;
  perform public.batch_settle_if_done(a.batch_id);
  return p_status;
end;
$$;

-- Internal: when no article of the batch is queued or writing, release the hold and charge for the ready ones only.
create function public.batch_settle_if_done(p_batch uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v        public.batches;
  v_ok     integer;
  v_failed integer;
  v_cancel integer;
  v_amount integer;
  v_ledger uuid;
  v_err    text;
begin
  select * into v from public.batches where id = p_batch for update;
  if not found or v.status <> 'running' then
    return false;
  end if;
  if exists (select 1 from public.articles where batch_id = v.id and status in ('queued', 'writing')) then
    return false;
  end if;
  select count(*) filter (where status = 'ready'), count(*) filter (where status = 'failed'), count(*) filter (where status = 'canceled')
    into v_ok, v_failed, v_cancel from public.articles where batch_id = v.id;

  v_amount := coalesce(v.credit_rate, 0) * v_ok;
  if v.credit_ledger_id is not null then
    if v_amount = v.credit_amount then
      perform public.credit_commit(v.credit_ledger_id);
    else
      perform public.credit_release(v.credit_ledger_id);
      if v_amount > 0 then
        begin
          v_ledger := public.credit_reserve(v.workspace_id, v_amount, 'batch_run', 'batch-settle:' || v.id::text, 'batch', v.id::text);
          perform public.credit_commit(v_ledger);
        exception when others then
          v_err := 'settle_failed:' || sqlstate;   -- the user is not charged; the owner can see it in the batch stats
          v_amount := 0;
        end;
      end if;
    end if;
  end if;
  update public.batches
  set status = 'completed', finished_at = now(), credit_amount = v_amount,
      stats = jsonb_build_object('ready', v_ok, 'failed', v_failed, 'canceled', v_cancel, 'charged', v_amount) ||
              case when v_err is null then '{}'::jsonb else jsonb_build_object('error', v_err) end
  where id = v.id;
  return true;
end;
$$;

-- Cancel a running batch: unfinished articles are cancelled (their items are free again), finished ones stay and are charged.
create function public.batch_run_cancel(p_user uuid, p_batch uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.batches;
  a record;
  v_n integer := 0;
begin
  v := public.batch_edit_guard(p_user, p_batch);
  if v.status <> 'running' then
    raise exception 'batch_not_running' using errcode = 'PM003';
  end if;
  for a in select id from public.articles where batch_id = v.id and status in ('queued', 'writing') order by id loop
    perform public.article_finish(a.id, 'canceled', 'canceled by user');
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Safety net, called from every worker tick (like map_run_watchdog): an article whose job died, or that has no live
-- job for a long while, is failed (credits are then settled by article_finish).
create function public.article_watchdog(p_idle_minutes integer default 15)
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
    select a.id, a.updated_at,
           exists (select 1 from public.jobs j where j.type like 'article.%' and j.payload ->> 'articleId' = a.id::text and j.state = 'dead') as has_dead,
           exists (select 1 from public.jobs j where j.type like 'article.%' and j.payload ->> 'articleId' = a.id::text and j.state in ('queued', 'running')) as has_live
    from public.articles a
    where a.status in ('queued', 'writing') and a.updated_at < now() - make_interval(mins => 1)
  loop
    if r.has_dead then
      perform public.article_finish(r.id, 'failed', 'a writing step failed permanently');
      v_n := v_n + 1;
    elsif not r.has_live and r.updated_at < now() - make_interval(mins => greatest(p_idle_minutes, 5)) then
      perform public.article_finish(r.id, 'failed', 'stalled: no job left to continue the article');
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- What one article really cost (tokens and USD of every LLM attempt of its jobs, failed attempts included).
create function public.article_cost_usd(p_article uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(l.cost_usd), 0)
  from public.llm_calls l join public.jobs j on j.id = l.job_id
  where j.payload ->> 'articleId' = p_article::text;
$$;

-- The basis for a price: per article status (ready / failed / ...), how many, and the average / min / max measured cost.
create function public.admin_article_cost_summary(p_days integer default 14)
returns table (
  status         text,
  articles       bigint,
  avg_calls      numeric,
  avg_input_tok  integer,
  avg_output_tok integer,
  avg_cost_usd   numeric,
  min_cost_usd   numeric,
  max_cost_usd   numeric,
  total_cost_usd numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with per as (
    select a.id, a.status,
           count(l.id) as calls,
           coalesce(sum(l.input_tokens), 0) as tin,
           coalesce(sum(l.output_tokens), 0) as tout,
           coalesce(sum(l.cost_usd), 0) as cost
    from public.articles a
    left join public.jobs j on j.payload ->> 'articleId' = a.id::text and j.type like 'article.%'
    left join public.llm_calls l on l.job_id = j.id
    where a.created_at >= now() - make_interval(days => least(greatest(coalesce(p_days, 14), 1), 90))
    group by a.id, a.status)
  select per.status, count(*), avg(per.calls)::numeric(10, 1), avg(per.tin)::integer, avg(per.tout)::integer,
         avg(per.cost)::numeric(12, 6), min(per.cost)::numeric(12, 6), max(per.cost)::numeric(12, 6), sum(per.cost)::numeric(12, 6)
  from per group by per.status order by per.status;
$$;

revoke all on function public.articles_touch() from public, anon, authenticated;
revoke all on function public.batch_run_start(uuid, uuid) from public, anon, authenticated;
revoke all on function public.article_finish(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.batch_settle_if_done(uuid) from public, anon, authenticated;
revoke all on function public.batch_run_cancel(uuid, uuid) from public, anon, authenticated;
revoke all on function public.article_watchdog(integer) from public, anon, authenticated;
revoke all on function public.article_cost_usd(uuid) from public, anon, authenticated;
revoke all on function public.admin_article_cost_summary(integer) from public, anon, authenticated;
grant execute on function public.batch_run_start(uuid, uuid) to service_role;
grant execute on function public.article_finish(uuid, text, text, jsonb) to service_role;
grant execute on function public.batch_run_cancel(uuid, uuid) to service_role;
grant execute on function public.article_watchdog(integer) to service_role;
grant execute on function public.article_cost_usd(uuid) to service_role;
grant execute on function public.admin_article_cost_summary(integer) to service_role;
