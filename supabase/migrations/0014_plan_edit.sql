-- 0014_plan_edit.sql — Batch 10: a member edits the structure of a finished plan by hand (merge, split, move to
-- another silo). No LLM calls, no credits: it only rearranges rows of one run.
--
-- Rules enforced HERE (the app calls these through the service role after authenticating the user):
--   * the caller must be a member of the run's workspace (42501); the run must exist (PM004);
--   * the run must be FINISHED (status succeeded) (PM003); the run row is locked so two edits never interleave;
--   * an item that is already APPROVED cannot be restructured (PM003): send it back to draft first;
--   * a silo's pillar cannot be merged away, split from, or moved (PM003): merge the other way round instead;
--   * only items / silos of THAT run are touched; a wrong id is PM004; invalid input is 22023.
-- After every change the link plan of the run is rebuilt from the silo structure (plan_links_fix): pillar <-> children
-- always match the silos, siblings that no longer share a silo are dropped, and an item with fewer than 2 siblings is
-- topped up with its nearest neighbours of the silo by position.

-- Internal: checks membership + finished run, locks the run, returns nothing.
create function public.plan_edit_guard(p_user uuid, p_run uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.map_runs;
begin
  select * into r from public.map_runs where id = p_run for update;
  if not found then
    raise exception 'map_run_not_found' using errcode = 'PM004';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = r.workspace_id and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if r.status <> 'succeeded' then
    raise exception 'run_not_finished' using errcode = 'PM003';
  end if;
end;
$$;

-- Internal: sizes + link plans of the whole run follow the current silo structure.
create function public.plan_links_fix(p_run uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.silos s
  set size = (select count(*) from public.plan_items i where i.silo_id = s.id)
  where s.map_run_id = p_run;

  update public.plan_items p
  set link_plan = jsonb_build_object(
    'pillar',   case when s.pillar_item_id is null or s.pillar_item_id = p.id then null else to_jsonb(s.pillar_item_id::text) end,
    'children', case when s.pillar_item_id = p.id
                     then coalesce((select jsonb_agg(c.id::text order by c.position, c.id) from public.plan_items c where c.silo_id = s.id and c.id <> p.id), '[]'::jsonb)
                     else '[]'::jsonb end,
    'siblings', case when s.pillar_item_id = p.id or p.silo_id is null then '[]'::jsonb else coalesce((
        select jsonb_agg(x.id::text order by x.keep desc, x.dist, x.pos) from (
          select q.id, q.position as pos, abs(q.position - p.position) as dist,
                 (q.id::text in (select jsonb_array_elements_text(coalesce(p.link_plan -> 'siblings', '[]'::jsonb)))) as keep,
                 row_number() over (order by (q.id::text in (select jsonb_array_elements_text(coalesce(p.link_plan -> 'siblings', '[]'::jsonb)))) desc,
                                    abs(q.position - p.position), q.position) as rn
          from public.plan_items q
          where q.silo_id = p.silo_id and q.id <> p.id and q.id is distinct from s.pillar_item_id) x
        where x.keep or x.rn <= 2), '[]'::jsonb) end,
    'anchors',  coalesce(p.link_plan -> 'anchors', '[]'::jsonb))
  from public.silos s
  where p.map_run_id = p_run and s.id = p.silo_id;
end;
$$;

-- Merge p_drop into p_keep: the dropped keyword and its variants become variants of the kept item; the dropped item
-- disappears (its keyword candidate is marked merged into the kept one).
create function public.plan_item_merge(p_user uuid, p_run uuid, p_keep uuid, p_drop uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  k public.plan_items;
  d public.plan_items;
  v_vars text[];
  v_anchors jsonb;
begin
  perform public.plan_edit_guard(p_user, p_run);
  if p_keep is null or p_drop is null or p_keep = p_drop then
    raise exception 'invalid_merge' using errcode = '22023';
  end if;
  select * into k from public.plan_items where id = p_keep and map_run_id = p_run;
  select * into d from public.plan_items where id = p_drop and map_run_id = p_run;
  if k.id is null or d.id is null then
    raise exception 'item_not_found' using errcode = 'PM004';
  end if;
  if k.status = 'approved' or d.status = 'approved' then
    raise exception 'item_approved' using errcode = 'PM003';
  end if;
  if exists (select 1 from public.silos s where s.map_run_id = p_run and s.pillar_item_id = d.id) then
    raise exception 'pillar_cannot_be_dropped' using errcode = 'PM003';
  end if;

  select coalesce(array_agg(v order by o), '{}') into v_vars from (
    select distinct on (lower(v)) v, o from unnest(k.variants || d.keyword || d.variants) with ordinality as t(v, o)
    where lower(v) <> lower(k.keyword) order by lower(v), o) z;
  v_anchors := coalesce(k.link_plan -> 'anchors', '[]'::jsonb);
  if jsonb_array_length(v_anchors) < 4 and not exists (select 1 from jsonb_array_elements_text(v_anchors) a where lower(a) = lower(d.keyword)) then
    v_anchors := v_anchors || to_jsonb(d.keyword);
  end if;

  update public.plan_items
  set variants = v_vars, link_plan = jsonb_set(link_plan, '{anchors}', v_anchors),
      flags = (select coalesce(array_agg(distinct f order by f), '{}') from unnest(flags || array['manual_merge']) f)
  where id = k.id;
  update public.kw_candidates set status = 'merged', merged_into = k.primary_kw_id, merge_reason = 'manual_merge'
  where id = d.primary_kw_id and map_run_id = p_run;
  delete from public.plan_items where id = d.id;
  perform public.plan_links_fix(p_run);
  return 1;
end;
$$;

-- Split: a variant of p_item becomes an item of its own (same silo, no title yet, flagged needs_title).
create function public.plan_item_split(p_user uuid, p_run uuid, p_item uuid, p_variant text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.plan_items;
  c public.kw_candidates;
  v_new uuid;
  v_text text := btrim(coalesce(p_variant, ''));
begin
  perform public.plan_edit_guard(p_user, p_run);
  if v_text = '' then
    raise exception 'invalid_variant' using errcode = '22023';
  end if;
  select * into i from public.plan_items where id = p_item and map_run_id = p_run;
  if i.id is null then
    raise exception 'item_not_found' using errcode = 'PM004';
  end if;
  if i.status = 'approved' then
    raise exception 'item_approved' using errcode = 'PM003';
  end if;
  if exists (select 1 from public.silos s where s.map_run_id = p_run and s.pillar_item_id = i.id) then
    raise exception 'pillar_cannot_be_split' using errcode = 'PM003';
  end if;
  if not exists (select 1 from unnest(i.variants) v where lower(v) = lower(v_text)) then
    raise exception 'variant_not_found' using errcode = 'PM004';
  end if;
  -- the keyword candidate behind this variant (a merged one of this run); without it the split cannot be recorded
  select * into c from public.kw_candidates
  where map_run_id = p_run and lower(raw) = lower(v_text) and status = 'merged'
    and not exists (select 1 from public.plan_items x where x.map_run_id = p_run and x.primary_kw_id = kw_candidates.id)
  order by seq limit 1;
  if c.id is null then
    raise exception 'variant_has_no_candidate' using errcode = 'PM004';
  end if;

  insert into public.plan_items (workspace_id, project_id, map_run_id, silo_id, primary_kw_id, keyword, variants, article_type,
                                 list_count, target_words, decision, status, intent, funnel, priority, score_detail, link_plan, gloss, flags, position)
  values (i.workspace_id, i.project_id, p_run, i.silo_id, c.id, c.raw, '{}', i.article_type, i.list_count, i.target_words, 'separate', 'draft',
          i.intent, i.funnel, i.priority, '{}'::jsonb, jsonb_build_object('anchors', jsonb_build_array(c.raw)), '{}'::jsonb,
          array['manual_split', 'needs_title'], (select coalesce(max(position), 0) + 1 from public.plan_items where map_run_id = p_run))
  returning id into v_new;
  update public.kw_candidates set status = 'primary', merged_into = null, merge_reason = null where id = c.id;
  update public.plan_items set variants = array(select v from unnest(variants) v where lower(v) <> lower(v_text)) where id = i.id;
  perform public.plan_links_fix(p_run);
  return v_new;
end;
$$;

-- Move items to another silo of the same run.
create function public.plan_items_move(p_user uuid, p_run uuid, p_ids uuid[], p_silo uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  perform public.plan_edit_guard(p_user, p_run);
  if p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 1000 or p_silo is null then
    raise exception 'invalid_move' using errcode = '22023';
  end if;
  if not exists (select 1 from public.silos where id = p_silo and map_run_id = p_run) then
    raise exception 'silo_not_found' using errcode = 'PM004';
  end if;
  if exists (select 1 from public.plan_items where map_run_id = p_run and id = any (p_ids) and status = 'approved') then
    raise exception 'item_approved' using errcode = 'PM003';
  end if;
  if exists (select 1 from public.silos s where s.map_run_id = p_run and s.pillar_item_id = any (p_ids)) then
    raise exception 'pillar_cannot_be_moved' using errcode = 'PM003';
  end if;
  update public.plan_items
  set silo_id = p_silo, link_plan = jsonb_set(link_plan, '{siblings}', '[]'::jsonb),
      flags = (select coalesce(array_agg(distinct f order by f), '{}') from unnest(flags || array['manual_move']) f)
  where map_run_id = p_run and id = any (p_ids) and silo_id is distinct from p_silo;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform public.plan_links_fix(p_run);
  end if;
  return v_n;
end;
$$;

revoke all on function public.plan_edit_guard(uuid, uuid) from public, anon, authenticated;
revoke all on function public.plan_links_fix(uuid) from public, anon, authenticated;
revoke all on function public.plan_item_merge(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.plan_item_split(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.plan_items_move(uuid, uuid, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.plan_item_merge(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.plan_item_split(uuid, uuid, uuid, text) to service_role;
grant execute on function public.plan_items_move(uuid, uuid, uuid[], uuid) to service_role;
