-- 0015_item_status_vocabulary.sql — Batch 11, part 1: plan_items.status follows PLAN §4.1.
--
-- Owner decision (2026-10-20): the full list, `draft` is renamed `proposed`.
--   proposed -> approved -> in_batch -> writing -> draft_ready -> in_review -> scheduled -> published -> pins_pending -> done
--   plus rejected and already_exists.
-- Only proposed / approved / rejected are set by people today (review page). in_batch comes with 0016 (batches); the rest
-- of the flow is written by the article / publish phases, which therefore need no migration for their statuses.
--
-- What this file does
--   1. swaps the CHECK constraint, renames existing `draft` rows to `proposed`, new default `proposed`;
--   2. plan_items_set_status / plan_items_approve_clean (0013): same rules, new vocabulary. The three statuses people may
--      set are proposed / approved / rejected; an item that is already further along (in a batch, being written, ...)
--      cannot be set back from here (PM003);
--   3. plan_item_merge / plan_item_split / plan_items_move (0014): same rules, but "frozen" now means any item that is
--      NOT proposed / rejected / already_exists (before: only `approved`); a split creates a `proposed` item.
-- Applied migrations 0013 and 0014 are NOT edited: the functions are redefined here (same signatures, same grants).

alter table public.plan_items drop constraint plan_items_status_check;
update public.plan_items set status = 'proposed' where status = 'draft';
alter table public.plan_items alter column status set default 'proposed';
alter table public.plan_items add constraint plan_items_status_check check (status in (
  'proposed', 'approved', 'in_batch', 'writing', 'draft_ready', 'in_review', 'scheduled', 'published', 'pins_pending', 'done',
  'rejected', 'already_exists'));

-- Internal: an item is "frozen" for structure edits as soon as it is approved or further along.
create function public.plan_item_is_frozen(p_status text)
returns boolean
language sql
immutable
set search_path = ''
as $$ select p_status not in ('proposed', 'rejected', 'already_exists') $$;

-- ---------------------------------------------------------------------------
-- 0013 functions, new vocabulary
-- ---------------------------------------------------------------------------
create or replace function public.plan_items_set_status(p_user uuid, p_run uuid, p_ids uuid[], p_status text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.map_runs;
  v_n integer;
begin
  if p_status is null or p_status not in ('proposed', 'approved', 'rejected') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  if p_ids is not null and cardinality(p_ids) > 1000 then
    raise exception 'too_many_ids' using errcode = '22023';
  end if;
  select * into r from public.map_runs where id = p_run;
  if not found then
    raise exception 'map_run_not_found' using errcode = 'PM004';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = r.workspace_id and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_status = 'approved' and (r.status <> 'succeeded' or coalesce(r.report ->> 'verdict', 'fail') = 'fail') then
    raise exception 'report_blocks_approval' using errcode = 'PM003';
  end if;
  if p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;
  -- an item that is already in a batch (or later) is not touched from the review page
  if exists (select 1 from public.plan_items where map_run_id = p_run and id = any (p_ids) and status not in ('proposed', 'approved', 'rejected')) then
    raise exception 'item_in_progress' using errcode = 'PM003';
  end if;
  update public.plan_items set status = p_status
  where map_run_id = p_run and id = any (p_ids) and status is distinct from p_status;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create or replace function public.plan_items_approve_clean(p_user uuid, p_run uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_total integer := 0;
  v_i integer := 1;
begin
  select coalesce(array_agg(pi.id), '{}') into v_ids
  from public.plan_items pi
  where pi.map_run_id = p_run and pi.status = 'proposed' and cardinality(pi.flags) = 0;
  if cardinality(v_ids) = 0 then
    -- still runs the membership / report checks so a stranger or a red report gets the right error
    return public.plan_items_set_status(p_user, p_run, '{}', 'approved');
  end if;
  -- up to 1000 per call; the loop keeps a very large plan working without lifting the limit
  while v_i <= cardinality(v_ids) loop
    v_total := v_total + public.plan_items_set_status(p_user, p_run, v_ids[v_i : least(v_i + 999, cardinality(v_ids))], 'approved');
    v_i := v_i + 1000;
  end loop;
  return v_total;
end;
$$;

-- ---------------------------------------------------------------------------
-- 0014 functions, "frozen" instead of "approved"; split creates `proposed`
-- ---------------------------------------------------------------------------
create or replace function public.plan_item_merge(p_user uuid, p_run uuid, p_keep uuid, p_drop uuid)
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
  if public.plan_item_is_frozen(k.status) or public.plan_item_is_frozen(d.status) then
    raise exception 'item_frozen' using errcode = 'PM003';
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

create or replace function public.plan_item_split(p_user uuid, p_run uuid, p_item uuid, p_variant text)
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
  if public.plan_item_is_frozen(i.status) then
    raise exception 'item_frozen' using errcode = 'PM003';
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
  values (i.workspace_id, i.project_id, p_run, i.silo_id, c.id, c.raw, '{}', i.article_type, i.list_count, i.target_words, 'separate', 'proposed',
          i.intent, i.funnel, i.priority, '{}'::jsonb, jsonb_build_object('anchors', jsonb_build_array(c.raw)), '{}'::jsonb,
          array['manual_split', 'needs_title'], (select coalesce(max(position), 0) + 1 from public.plan_items where map_run_id = p_run))
  returning id into v_new;
  update public.kw_candidates set status = 'primary', merged_into = null, merge_reason = null where id = c.id;
  update public.plan_items set variants = array(select v from unnest(variants) v where lower(v) <> lower(v_text)) where id = i.id;
  perform public.plan_links_fix(p_run);
  return v_new;
end;
$$;

create or replace function public.plan_items_move(p_user uuid, p_run uuid, p_ids uuid[], p_silo uuid)
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
  if exists (select 1 from public.plan_items where map_run_id = p_run and id = any (p_ids) and public.plan_item_is_frozen(status)) then
    raise exception 'item_frozen' using errcode = 'PM003';
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

revoke all on function public.plan_item_is_frozen(text) from public, anon, authenticated;
grant execute on function public.plan_item_is_frozen(text) to service_role;
-- create or replace keeps the grants of 0013 / 0014; stated again so this file reads on its own
revoke all on function public.plan_items_set_status(uuid, uuid, uuid[], text) from public, anon, authenticated;
revoke all on function public.plan_items_approve_clean(uuid, uuid) from public, anon, authenticated;
revoke all on function public.plan_item_merge(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.plan_item_split(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.plan_items_move(uuid, uuid, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.plan_items_set_status(uuid, uuid, uuid[], text) to service_role;
grant execute on function public.plan_items_approve_clean(uuid, uuid) to service_role;
grant execute on function public.plan_item_merge(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.plan_item_split(uuid, uuid, uuid, text) to service_role;
grant execute on function public.plan_items_move(uuid, uuid, uuid[], uuid) to service_role;
