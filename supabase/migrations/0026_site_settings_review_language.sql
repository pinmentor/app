-- 0026_site_settings_review_language.sql — Batch 23b. Requires 0001 (languages, workspaces, members) and 0021 (sites).
--
--   * sites.language / sites.locale / sites.cta_label : the CONTENT language of a website (what its articles are written in),
--     and the one call-to-action text used on that site everywhere (CLAUDE.md: CTA = sites.cta_label). This is not the
--     language of the app's own screens, which is American English everywhere.
--   * workspaces.review_language : which translation (Bengali / English) the review screens show by default; one value
--     for the whole workspace (owner/admin changes it).
--   * site_update_settings / workspace_set_review_language : service-role only, called by the server with p_user; the
--     functions re-check membership. Clients still cannot write these tables directly.
-- Existing sites become es / es-MX (the first site is Spanish); the owner can change it on the Websites page.

alter table public.sites
  add column language  text not null default 'es' references public.languages (code),
  add column locale    text not null default 'es-MX' check (locale ~ '^[a-z]{2}-[A-Z]{2}$'),
  add column cta_label text check (cta_label is null or char_length(cta_label) between 1 and 60);
alter table public.sites add constraint sites_locale_matches_language check (left(locale, 2) = language);
-- sites uses column-level grants (0021): the new readable columns must be added by hand
grant select (language, locale, cta_label) on public.sites to authenticated;

alter table public.workspaces
  add column review_language text not null default 'bn' check (review_language in ('bn', 'en'));
-- workspaces: authenticated may read all columns (table grant) and update only `name` (0001) — review_language is written by the function below

create function public.site_update_settings(p_user uuid, p_site uuid, p_language text, p_locale text, p_cta text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.sites;
  v_cta text := nullif(btrim(coalesce(p_cta, '')), '');
begin
  select * into s from public.sites where id = p_site;
  if not found then raise exception 'site_not_found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = s.workspace_id and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_language is null or not exists (select 1 from public.languages l where l.code = p_language) then
    raise exception 'bad_language' using errcode = '22023';
  end if;
  if p_locale is null or p_locale !~ '^[a-z]{2}-[A-Z]{2}$' or left(p_locale, 2) <> p_language then
    raise exception 'bad_locale' using errcode = '22023';
  end if;
  if v_cta is not null and char_length(v_cta) > 60 then
    raise exception 'bad_cta' using errcode = '22023';
  end if;
  update public.sites set language = p_language, locale = p_locale, cta_label = v_cta where id = p_site;
end;
$$;

create function public.workspace_set_review_language(p_user uuid, p_workspace uuid, p_lang text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.workspace_members m where m.workspace_id = p_workspace and m.user_id = p_user and m.role in ('owner', 'admin')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_lang is null or p_lang not in ('bn', 'en') then
    raise exception 'bad_language' using errcode = '22023';
  end if;
  update public.workspaces set review_language = p_lang where id = p_workspace;
end;
$$;

revoke all on function public.site_update_settings(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.workspace_set_review_language(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.site_update_settings(uuid, uuid, text, text, text) to service_role;
grant execute on function public.workspace_set_review_language(uuid, uuid, text) to service_role;
