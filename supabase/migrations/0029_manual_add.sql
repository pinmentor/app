-- 0029_manual_add.sql — Batch 24b: a member adds a keyword to a finished map by hand. Requires 0008, 0010, 0014, 0015.
--
--   * plan_item_add_manual : the keyword becomes an item of its own (status proposed, in a silo the member picked, flag manual_add;
--       flag forced when the member went on although the check found a similar item; flag needs_title when no title was given).
--   * plan_item_add_variant : the keyword is recorded as a variant of an existing item ("same article"); nothing new is created.
-- The similarity CHECK happens in the app before these are called; these functions only enforce what must always hold:
--   member of the run's workspace (42501), run exists and is finished (PM004 / PM003, plan_edit_guard), the silo / item belongs
--   to the run (PM004), an item that is approved or further along cannot get a variant (PM003), the exact same keyword
--   (case-insensitive) is never in a run twice (PM006), text 1..200 characters and at most 12 words (22023).
-- No LLM call and no credits here. Called with the service role after the app has authenticated the user.

create function public.plan_item_add_manual(p_user uuid, p_run uuid, p_text text, p_title text, p_silo uuid, p_force boolean default false)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r        public.map_runs;
  v_text   text := btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g'));
  v_title  text := nullif(left(btrim(coalesce(p_title, '')), 200), '');
  v_cand   uuid;
  v_item   uuid;
  mate     public.plan_items;
begin
  perform public.plan_edit_guard(p_user, p_run);
  if char_length(v_text) not between 1 and 200 or cardinality(string_to_array(v_text, ' ')) > 12 then
    raise exception 'invalid_text' using errcode = '22023';
  end if;
  select * into r from public.map_runs where id = p_run;
  if p_silo is null or not exists (select 1 from public.silos s where s.id = p_silo and s.map_run_id = p_run) then
    raise exception 'silo_not_found' using errcode = 'PM004';
  end if;
  if exists (select 1 from public.kw_candidates c where c.map_run_id = p_run and c.raw_key = lower(v_text)) then
    raise exception 'already_in_map' using errcode = 'PM006';
  end if;

  select * into mate from public.plan_items where map_run_id = p_run and silo_id = p_silo order by position limit 1;
  insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, status, seq)
  values (r.workspace_id, p_run, v_text, lower(v_text), r.language, 'manual', 'primary',
          (select coalesce(max(seq), 0) + 1 from public.kw_candidates where map_run_id = p_run))
  returning id into v_cand;

  insert into public.plan_items (workspace_id, project_id, map_run_id, silo_id, primary_kw_id, keyword, variants, title, article_type,
                                 list_count, decision, status, intent, funnel, priority, link_plan, flags, position)
  values (r.workspace_id, r.project_id, p_run, p_silo, v_cand, v_text, '{}', v_title, 'A',
          coalesce(mate.list_count, 7), 'separate', 'proposed', mate.intent, mate.funnel, 0,
          jsonb_build_object('anchors', jsonb_build_array(v_text)),
          array['manual_add'] || case when v_title is null then array['needs_title'] else '{}'::text[] end || case when p_force then array['forced'] else '{}'::text[] end,
          (select coalesce(max(position), 0) + 1 from public.plan_items where map_run_id = p_run))
  returning id into v_item;
  perform public.plan_links_fix(p_run);
  return v_item;
end;
$$;

create function public.plan_item_add_variant(p_user uuid, p_run uuid, p_item uuid, p_text text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r      public.map_runs;
  i      public.plan_items;
  v_text text := btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g'));
begin
  perform public.plan_edit_guard(p_user, p_run);
  if char_length(v_text) not between 1 and 200 or cardinality(string_to_array(v_text, ' ')) > 12 then
    raise exception 'invalid_text' using errcode = '22023';
  end if;
  select * into r from public.map_runs where id = p_run;
  select * into i from public.plan_items where id = p_item and map_run_id = p_run;
  if i.id is null then
    raise exception 'item_not_found' using errcode = 'PM004';
  end if;
  if public.plan_item_is_frozen(i.status) then
    raise exception 'item_frozen' using errcode = 'PM003';
  end if;
  if exists (select 1 from public.kw_candidates c where c.map_run_id = p_run and c.raw_key = lower(v_text)) then
    raise exception 'already_in_map' using errcode = 'PM006';
  end if;
  insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, status, merged_into, merge_reason)
  values (r.workspace_id, p_run, v_text, lower(v_text), r.language, 'manual', 'merged', i.primary_kw_id, 'manual_add');
  update public.plan_items
  set variants = i.variants || v_text,
      flags = (select coalesce(array_agg(distinct f order by f), '{}') from unnest(flags || array['manual_variant']) f)
  where id = i.id;
  perform public.plan_links_fix(p_run);
  return 1;
end;
$$;

revoke all on function public.plan_item_add_manual(uuid, uuid, text, text, uuid, boolean) from public, anon, authenticated;
revoke all on function public.plan_item_add_variant(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.plan_item_add_manual(uuid, uuid, text, text, uuid, boolean) to service_role;
grant execute on function public.plan_item_add_variant(uuid, uuid, uuid, text) to service_role;
