-- 0028_keywords_import_fix.sql — fix for 0027 (found by rls_0027 on the real Supabase).
--
-- keywords_import (0027) used `create temp table ... on commit drop`. Inside ONE transaction (the SQL Editor runs a whole
-- script as one) a second call tried to create the same temp table again: SQLSTATE 42P07. The app calls it once per
-- transaction, so the app was not hit, but the function must not depend on that. This version has no temp table: one
-- statement with CTEs. Same inputs, same result {"added","duplicates","invalid"}, same checks and same limits.
-- (0027 is not edited; create or replace keeps the existing grants.)

create or replace function public.keywords_import(p_user uuid, p_workspace uuid, p_lang text, p_kind text, p_source text, p_site uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer;
  v_valid integer;
  v_added integer;
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

  with src as (
    select btrim(e ->> 'text') as text, btrim(e ->> 'norm_key') as norm_key,
           coalesce((select array_agg(distinct left(btrim(t), 40)) from jsonb_array_elements_text(
              case when jsonb_typeof(e -> 'tags') = 'array' then e -> 'tags' else '[]'::jsonb end) t where btrim(t) <> ''), '{}'::text[]) as tags
    from jsonb_array_elements(p_items) e
    where jsonb_typeof(e) = 'object' and jsonb_typeof(e -> 'text') = 'string' and jsonb_typeof(e -> 'norm_key') = 'string'
  ), good as (
    select * from src
    where char_length(text) between 1 and 200 and char_length(norm_key) between 1 and 200 and cardinality(tags) <= 10
  ), ins as (
    insert into public.keyword_library (workspace_id, site_id, text, norm_key, lang, kind, source, tags)
    select p_workspace, p_site, g.text, g.norm_key, p_lang, p_kind, p_source, g.tags from good g
    on conflict (workspace_id, lang, kind, norm_key) do nothing
    returning 1
  )
  select (select count(*) from good), (select count(*) from ins) into v_valid, v_added;

  if (select count(*) from public.keyword_library where workspace_id = p_workspace) > 5000 then
    raise exception 'library_full' using errcode = '54000';
  end if;
  return jsonb_build_object('added', v_added, 'duplicates', v_valid - v_added, 'invalid', v_total - v_valid);
end;
$$;
