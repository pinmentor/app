-- 0013_plan_review.sql — Batch 09: a member reviews the plan (approve / reject / back to draft).
--
-- Rules enforced HERE, not in the app (the app only calls these functions through the service role after it has
-- authenticated the user; the function re-checks membership itself, like map_run_cancel):
--   * the caller must be a member of the run's workspace (42501), the run must exist (PM004);
--   * `approved` needs a FINISHED run (status succeeded) whose verification report is not red: a missing or `fail`
--     report blocks approval (PM003). Rejecting and going back to draft are always allowed (they spend and publish nothing);
--   * at most 1000 ids per call (22023); a status other than draft / approved / rejected is refused (22023);
--   * only items of THAT run are touched; the return value is the number of rows really changed (idempotent: 0 on replay).
create function public.plan_items_set_status(p_user uuid, p_run uuid, p_ids uuid[], p_status text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.map_runs;
  v_n integer;
begin
  if p_status is null or p_status not in ('draft', 'approved', 'rejected') then
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
  update public.plan_items set status = p_status
  where map_run_id = p_run and id = any (p_ids) and status is distinct from p_status;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- "Approve everything that has no flag": draft items with an empty flag list. Same gates as above.
create function public.plan_items_approve_clean(p_user uuid, p_run uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  select coalesce(array_agg(pi.id), '{}') into v_ids
  from public.plan_items pi
  where pi.map_run_id = p_run and pi.status = 'draft' and cardinality(pi.flags) = 0;
  -- up to 1000 per call; the loop keeps a very large plan working without lifting the limit
  declare
    v_total integer := 0;
    v_i integer := 1;
  begin
    if cardinality(v_ids) = 0 then
      -- still runs the membership / report checks so a stranger or a red report gets the right error
      return public.plan_items_set_status(p_user, p_run, '{}', 'approved');
    end if;
    while v_i <= cardinality(v_ids) loop
      v_total := v_total + public.plan_items_set_status(p_user, p_run, v_ids[v_i : least(v_i + 999, cardinality(v_ids))], 'approved');
      v_i := v_i + 1000;
    end loop;
    return v_total;
  end;
end;
$$;

revoke all on function public.plan_items_set_status(uuid, uuid, uuid[], text) from public, anon, authenticated;
revoke all on function public.plan_items_approve_clean(uuid, uuid) from public, anon, authenticated;
grant execute on function public.plan_items_set_status(uuid, uuid, uuid[], text) to service_role;
grant execute on function public.plan_items_approve_clean(uuid, uuid) to service_role;
