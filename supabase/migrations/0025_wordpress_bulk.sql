-- 0025_wordpress_bulk.sql — Batch 21: send a whole batch to WordPress in the background (drafts, or published gradually). Requires 0022.
--
--   * articles.wp_when / wp_error : the time planned for a scheduled article (site time, text) and the last reason a send failed.
--   * articles_wp_enqueue : member-only; for a batch of the caller's workspace, queues ONE `wp.send` job per listed article
--                           (ready articles of that batch only; mode draft | publish | future; future needs a time).
--                           Idempotent: pressing twice while a job is waiting queues nothing new; a finished or dead job allows a new one.
-- Job payload key is `wpArticleId` (not `articleId`) so article cost reports and the article watchdog ignore it.
-- Credits: free.

alter table public.articles
  add column wp_when  text check (wp_when is null or wp_when ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  add column wp_error text check (wp_error is null or char_length(wp_error) <= 120);

create function public.articles_wp_enqueue(p_user uuid, p_batch uuid, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.batches;
  e jsonb;
  v_art uuid;
  v_mode text;
  v_when text;
  v_pre text;
  v_n integer;
  v_cnt integer := 0;
begin
  select * into b from public.batches where id = p_batch;
  if not found then
    raise exception 'batch_not_found' using errcode = 'PM004';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = b.workspace_id and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'invalid_items' using errcode = '22023';
  end if;

  for e in select * from jsonb_array_elements(p_items) loop
    v_art := (e ->> 'article_id')::uuid;
    v_mode := e ->> 'mode';
    v_when := e ->> 'when';
    if v_mode is null or v_mode not in ('draft', 'publish', 'future') then
      raise exception 'invalid_mode' using errcode = '22023';
    end if;
    if v_mode = 'future' and (v_when is null or v_when !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$') then
      raise exception 'invalid_when' using errcode = '22023';
    end if;
    if not exists (select 1 from public.articles a where a.id = v_art and a.batch_id = b.id and a.workspace_id = b.workspace_id and a.status = 'ready') then
      raise exception 'article_not_ready' using errcode = 'PM003';
    end if;
    v_pre := 'wp:' || v_art::text || ':';
    select count(*) into v_n from public.jobs where left(idempotency_key, length(v_pre)) = v_pre and state in ('dead', 'canceled', 'succeeded');
    perform public.job_enqueue(b.workspace_id, 'wp.send',
                               jsonb_build_object('wpArticleId', v_art, 'userId', p_user, 'mode', v_mode, 'when', v_when),
                               v_pre || v_n::text, null, now(), 3, 0, null, null, 'wordpress');
    update public.articles set wp_when = case when v_mode = 'future' then v_when else null end, wp_error = null where id = v_art;
    v_cnt := v_cnt + 1;
  end loop;
  return v_cnt;
end;
$$;

revoke all on function public.articles_wp_enqueue(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.articles_wp_enqueue(uuid, uuid, jsonb) to service_role;
