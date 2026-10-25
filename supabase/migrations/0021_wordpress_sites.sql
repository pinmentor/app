-- 0021_wordpress_sites.sql — Batch 16: WordPress connection and "send as draft". Requires 0008, 0018, 0020.
--
--   * sites : a user's WordPress site (https URL, user name, Application Password). The password is encrypted IN THE APP
--             (AES-256-GCM, same master key as platform secrets); the database only holds ciphertext. The ciphertext column is
--             not readable by `authenticated` (column grants), only by the server (service_role) through site_article_target.
--   * site_connect / site_record_test / site_delete / project_set_site : member-only, called by the server with p_user.
--   * site_article_target : which site an article goes to (project's site, else the workspace's only site) + the stored post id.
--   * articles.wp_* : where the draft lives, so pressing the button again UPDATES the same post (no duplicates).
-- Credits: sending a draft is free (no price exists for it).

create table public.sites (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  name           text not null check (char_length(name) between 1 and 80),
  base_url       text not null check (char_length(base_url) <= 200 and base_url ~ '^https://[^/@[:space:]]+(/[^?#[:space:]]*)?$'),
  wp_user        text not null check (char_length(wp_user) between 1 and 100),
  ciphertext     text not null check (char_length(ciphertext) between 20 and 4000 and ciphertext like 'v1.%'),
  last4          text not null check (char_length(last4) = 4),
  status         text not null default 'untested' check (status in ('untested', 'connected', 'failed')),
  last_test_at   timestamptz,
  last_test_code text check (last_test_code is null or char_length(last_test_code) <= 60),
  created_at     timestamptz not null default now(),
  unique (workspace_id, base_url)
);
create index sites_workspace_idx on public.sites (workspace_id);

alter table public.sites enable row level security;
create policy sites_select on public.sites for select to authenticated using (public.is_workspace_member(workspace_id));
revoke all on public.sites from public, anon, authenticated;
grant select (id, workspace_id, name, base_url, wp_user, last4, status, last_test_at, last_test_code, created_at) on public.sites to authenticated;
grant select, insert, update, delete on public.sites to service_role;

alter table public.projects add constraint projects_site_fk foreign key (site_id) references public.sites (id) on delete set null;

alter table public.articles
  add column wp_site_id   uuid references public.sites (id) on delete set null,
  add column wp_post_id   bigint,
  add column wp_edit_url  text check (wp_edit_url is null or char_length(wp_edit_url) <= 500),
  add column wp_pushed_at timestamptz;

-- ---------------------------------------------------------------------------
create function public.site_connect(p_user uuid, p_workspace uuid, p_name text, p_base_url text, p_wp_user text, p_ciphertext text, p_last4 text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from public.workspace_members m where m.workspace_id = p_workspace and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select id into v_id from public.sites where workspace_id = p_workspace and base_url = p_base_url;
  if v_id is null then
    if (select count(*) from public.sites where workspace_id = p_workspace) >= 5 then
      raise exception 'site_limit' using errcode = '22023';
    end if;
    insert into public.sites (workspace_id, name, base_url, wp_user, ciphertext, last4)
    values (p_workspace, p_name, p_base_url, p_wp_user, p_ciphertext, p_last4) returning id into v_id;
  else
    -- the same address again = new credentials for the same site (articles and projects keep pointing at it)
    update public.sites set name = p_name, wp_user = p_wp_user, ciphertext = p_ciphertext, last4 = p_last4,
      status = 'untested', last_test_at = null, last_test_code = null where id = v_id;
  end if;
  return v_id;
end;
$$;

create function public.site_record_test(p_user uuid, p_site uuid, p_ok boolean, p_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.sites;
begin
  select * into s from public.sites where id = p_site;
  if not found then
    raise exception 'site_not_found' using errcode = 'PM004';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = s.workspace_id and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.sites set status = case when p_ok then 'connected' else 'failed' end, last_test_at = now(), last_test_code = left(p_code, 60) where id = s.id;
end;
$$;

create function public.site_delete(p_user uuid, p_site uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.sites;
begin
  select * into s from public.sites where id = p_site;
  if not found then
    raise exception 'site_not_found' using errcode = 'PM004';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = s.workspace_id and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.sites where id = s.id;   -- projects.site_id and articles.wp_site_id become null
end;
$$;

create function public.project_set_site(p_user uuid, p_project uuid, p_site uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  pr public.projects;
begin
  select * into pr from public.projects where id = p_project;
  if not found then
    raise exception 'project_not_found' using errcode = 'PM004';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = pr.workspace_id and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_site is not null and not exists (select 1 from public.sites s where s.id = p_site and s.workspace_id = pr.workspace_id) then
    raise exception 'site_not_found' using errcode = 'PM004';
  end if;
  update public.projects set site_id = p_site where id = pr.id;
end;
$$;

-- Where does this article go? Project's site first, else the workspace's only site.
-- PM003 article not ready; PM004 no site connected; 22023 several sites and none chosen for the project.
create function public.site_article_target(p_user uuid, p_article uuid)
returns table (project_id uuid, site_id uuid, base_url text, wp_user text, ciphertext text, wp_post_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  a    public.articles;
  v_site uuid;
  v_n  integer;
begin
  select * into a from public.articles where id = p_article;
  if not found then
    raise exception 'article_not_found' using errcode = 'PM004';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = a.workspace_id and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if a.status <> 'ready' then
    raise exception 'article_not_ready' using errcode = 'PM003';
  end if;
  select pr.site_id into v_site from public.projects pr where pr.id = a.project_id;
  if v_site is null then
    select count(*) into v_n from public.sites s where s.workspace_id = a.workspace_id;
    if v_n = 0 then
      raise exception 'no_site' using errcode = 'PM004';
    elsif v_n > 1 then
      raise exception 'site_choice' using errcode = '22023';
    end if;
    select s.id into v_site from public.sites s where s.workspace_id = a.workspace_id;
  end if;
  return query
    select a.project_id, s.id, s.base_url, s.wp_user, s.ciphertext,
           case when a.wp_site_id = s.id then a.wp_post_id else null end
    from public.sites s where s.id = v_site and s.workspace_id = a.workspace_id;
end;
$$;

-- Remember the draft (and attach the project to the site when it had none).
create function public.article_wp_saved(p_user uuid, p_article uuid, p_site uuid, p_post_id bigint, p_edit_url text)
returns void
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
  if not exists (select 1 from public.sites s where s.id = p_site and s.workspace_id = a.workspace_id) then
    raise exception 'site_not_found' using errcode = 'PM004';
  end if;
  update public.articles set wp_site_id = p_site, wp_post_id = p_post_id, wp_edit_url = left(p_edit_url, 500), wp_pushed_at = now() where id = a.id;
  update public.projects set site_id = p_site where id = a.project_id and site_id is null;
end;
$$;

revoke all on function public.site_connect(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.site_record_test(uuid, uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.site_delete(uuid, uuid) from public, anon, authenticated;
revoke all on function public.project_set_site(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.site_article_target(uuid, uuid) from public, anon, authenticated;
revoke all on function public.article_wp_saved(uuid, uuid, uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.site_connect(uuid, uuid, text, text, text, text, text) to service_role;
grant execute on function public.site_record_test(uuid, uuid, boolean, text) to service_role;
grant execute on function public.site_delete(uuid, uuid) to service_role;
grant execute on function public.project_set_site(uuid, uuid, uuid) to service_role;
grant execute on function public.site_article_target(uuid, uuid) to service_role;
grant execute on function public.article_wp_saved(uuid, uuid, uuid, bigint, text) to service_role;
