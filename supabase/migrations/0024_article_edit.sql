-- 0024_article_edit.sql — Batch 20: the owner edits a finished article's text. Requires 0018, 0019.
--
--   * articles.edited_at : when the text was last edited by hand.
--   * article_edit_save  : member-only; article must be `ready`. Replaces the content of the given existing sections
--                          (kind, idx, content, words), sets the title, stamps edited_at, and deletes the stored translations
--                          (they would describe the old text). All or nothing: if any listed section does not exist the call fails (PM004).
-- The app re-renders the HTML, re-runs the mechanical QA and updates body_html / qa / schema afterwards (same as the assemble step).
-- Credits: free.

alter table public.articles add column edited_at timestamptz;

create function public.article_edit_save(p_user uuid, p_article uuid, p_title text, p_sections jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.articles;
  e jsonb;
  v_n integer := 0;
  v_rows integer;
begin
  select * into a from public.articles where id = p_article for update;
  if not found then
    raise exception 'article_not_found' using errcode = 'PM004';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = a.workspace_id and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if a.status <> 'ready' then
    raise exception 'article_not_ready' using errcode = 'PM003';
  end if;
  if p_title is null or char_length(btrim(p_title)) not between 8 and 160 then
    raise exception 'invalid_title' using errcode = '22023';
  end if;
  if p_sections is null or jsonb_typeof(p_sections) <> 'array' or jsonb_array_length(p_sections) = 0 then
    raise exception 'invalid_sections' using errcode = '22023';
  end if;

  for e in select * from jsonb_array_elements(p_sections) loop
    update public.article_sections
    set content = e -> 'content', words = coalesce((e ->> 'words')::integer, words)
    where article_id = a.id and kind = e ->> 'kind' and idx = (e ->> 'idx')::integer;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'section_not_found' using errcode = 'PM004';
    end if;
    v_n := v_n + 1;
  end loop;

  update public.articles set title = btrim(p_title), edited_at = now() where id = a.id;
  delete from public.article_gloss where article_id = a.id;
  return v_n;
end;
$$;

revoke all on function public.article_edit_save(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.article_edit_save(uuid, uuid, text, jsonb) to service_role;
