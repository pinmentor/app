-- 0022_wordpress_publish.sql — Batch 18: publish / schedule on WordPress and live internal links. Requires 0020, 0021.
--
--   * articles.wp_status / wp_link : what WordPress says about the post (draft | publish | future) and its public address.
--   * article_wp_saved (replaced; new signature) : also stores status and link, and moves the plan item along the EXISTING
--     statuses: publish -> 'published', future -> 'scheduled' (only from draft_ready / scheduled; nothing else is touched).
--   * article_live_links : the planned internal links of an article (articles.links, in plan order) whose target article is really
--     published on the same site. Only these may be linked: a link to a draft or an unwritten article would be a broken link.
-- Credits: publishing and scheduling are free (no price exists for them).

alter table public.articles
  add column wp_status text check (wp_status is null or wp_status in ('draft', 'publish', 'future')),
  add column wp_link   text check (wp_link is null or char_length(wp_link) <= 500);

drop function public.article_wp_saved(uuid, uuid, uuid, bigint, text);

create function public.article_wp_saved(p_user uuid, p_article uuid, p_site uuid, p_post_id bigint, p_edit_url text, p_status text, p_link text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.articles;
begin
  if p_status is null or p_status not in ('draft', 'publish', 'future') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  select * into a from public.articles where id = p_article;
  if not found then
    raise exception 'article_not_found' using errcode = 'PM004';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = a.workspace_id and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.sites s where s.id = p_site and s.workspace_id = a.workspace_id) then
    raise exception 'site_not_found' using errcode = 'PM004';
  end if;
  update public.articles
  set wp_site_id = p_site, wp_post_id = p_post_id, wp_edit_url = left(p_edit_url, 500), wp_pushed_at = now(),
      wp_status = p_status, wp_link = left(p_link, 500)
  where id = a.id;
  update public.projects set site_id = p_site where id = a.project_id and site_id is null;
  if p_status = 'publish' then
    update public.plan_items set status = 'published' where id = a.plan_item_id and status in ('draft_ready', 'scheduled');
  elsif p_status = 'future' then
    update public.plan_items set status = 'scheduled' where id = a.plan_item_id and status = 'draft_ready';
  end if;
end;
$$;

create function public.article_live_links(p_user uuid, p_article uuid, p_site uuid)
returns table (role text, title text, slug text, link text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.articles;
begin
  select * into a from public.articles where id = p_article;
  if not found then
    raise exception 'article_not_found' using errcode = 'PM004';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = a.workspace_id and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select e.value ->> 'role', e.value ->> 'title', e.value ->> 'slug', b.wp_link
    from jsonb_array_elements(a.links) with ordinality as e(value, n)
    join public.articles b on b.plan_item_id::text = e.value ->> 'plan_item_id'
    where b.workspace_id = a.workspace_id and b.id <> a.id and b.status = 'ready'
      and b.wp_status = 'publish' and b.wp_site_id = p_site and b.wp_link is not null
    order by e.n;
end;
$$;

revoke all on function public.article_wp_saved(uuid, uuid, uuid, bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.article_live_links(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.article_wp_saved(uuid, uuid, uuid, bigint, text, text, text) to service_role;
grant execute on function public.article_live_links(uuid, uuid, uuid) to service_role;
