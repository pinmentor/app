-- 0019_article_review.sql — Batch 13: language review (a second model reads the article), translation gloss, traffic light.
-- Requires 0015-0018. See PLAN §5.1 (the owner cannot read Spanish, so the tool must help judge an article blind).
--
--   * articles.review      : result of the language review (issues, risky claims, which model, cross-model or not). The traffic
--                            light (green / yellow / red) is computed in the app from articles.qa + articles.review.
--   * article_gloss        : translation of an article into English or Bengali, in parts (head, intro, items, faq, conclusion),
--                            written by `article.gloss` jobs. On demand, one request per (article, language).
--   * article_gloss_request: member-only; the article must be `ready`; enqueues one job per part. Idempotent: a replay changes
--                            nothing; a part whose job died is queued again (key suffix = number of dead/cancelled tries).
--   * article_finish       : redefined (same signature, same grants) so its patch can carry `review`.
--   * llm_routes           : new task `article_gloss` (cheap class: it is plain translation).
-- Gloss jobs carry `glossArticleId` (NOT `articleId`) in their payload on purpose: the article cost report and the article
-- watchdog look at `articleId`, so a translation requested later never counts as the cost of writing the article.
-- Credits: a gloss is not charged (no price exists for it); the AI cost shows up under the task `article_gloss` on /admin/credits.

alter table public.articles add column review jsonb not null default '{}'::jsonb;

create or replace function public.article_finish(p_article uuid, p_status text, p_error text default null, p_patch jsonb default null)
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
      review = coalesce(p -> 'review', review),
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


create table public.article_gloss (
  article_id   uuid not null references public.articles (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lang         text not null check (lang in ('en', 'bn')),
  kind         text not null check (kind in ('head', 'intro', 'item', 'faq', 'conclusion')),
  idx          integer not null check (idx >= 0),
  content      jsonb not null,
  created_at   timestamptz not null default now(),
  primary key (article_id, lang, kind, idx)
);
create index article_gloss_workspace_idx on public.article_gloss (workspace_id);

alter table public.article_gloss enable row level security;
revoke all on public.article_gloss from public, anon, authenticated;
grant select on public.article_gloss to authenticated;
create policy article_gloss_select on public.article_gloss for select to authenticated using (public.is_workspace_member(workspace_id));
-- the app (service role) writes these tables; stated explicitly instead of relying on the platform's default privileges
grant select, insert, update, delete on public.article_gloss, public.article_sections, public.articles to service_role;

-- Translation of a finished article: returns how many part-jobs exist for this language (new or already there).
create function public.article_gloss_request(p_user uuid, p_article uuid, p_lang text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  a      public.articles;
  v_n    integer;
  v_part text;
  v_pre  text;
  v_dead integer;
  v_cnt  integer := 0;
  v_parts text[];
begin
  select * into a from public.articles where id = p_article;
  if not found then
    raise exception 'article_not_found' using errcode = 'PM004';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = a.workspace_id and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_lang is null or p_lang not in ('en', 'bn') then
    raise exception 'invalid_lang' using errcode = '22023';
  end if;
  if a.status <> 'ready' then
    raise exception 'article_not_ready' using errcode = 'PM003';
  end if;
  v_n := coalesce((a.outline ->> 'n')::integer, 0);
  if v_n < 1 then
    raise exception 'article_not_ready' using errcode = 'PM003';
  end if;

  v_parts := array['head', 'intro']::text[];
  for i in 0 .. ((v_n - 1) / 6) loop
    v_parts := v_parts || ('items:' || (i * 6)::text);
  end loop;
  v_parts := v_parts || 'faq'::text;

  foreach v_part in array v_parts loop
    v_pre := 'gloss:' || a.id::text || ':' || p_lang || ':' || v_part || ':';
    select count(*) into v_dead from public.jobs where left(idempotency_key, length(v_pre)) = v_pre and state in ('dead', 'canceled');
    perform public.job_enqueue(a.workspace_id, 'article.gloss',
                               jsonb_build_object('glossArticleId', a.id, 'lang', p_lang, 'part', v_part),
                               v_pre || v_dead::text, null, now(), 3, 0, null, null, 'gloss');
    v_cnt := v_cnt + 1;
  end loop;
  return v_cnt;
end;
$$;

revoke all on function public.article_gloss_request(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.article_gloss_request(uuid, uuid, text) to service_role;

insert into public.llm_routes (task, model_keys, description) values
  ('article_gloss', array['anthropic.haiku-5-5','gemini.3-5-flash-lite','openai.gpt-6-luna'], 'cheap: translation of an article for the owner''s review');
