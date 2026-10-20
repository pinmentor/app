-- 0011_auto_size.sql — Batch 07: "Auto" map size.
--
-- A run is either `custom` (the owner gives min and max) or `auto` (the topic decides its own size; the owner gives
-- only a CEILING, stored as target_max). The size mode lives in map_runs.params ->> 'size'.
--
-- MONEY: credits are reserved for the CEILING when the run starts (the worst case, so the run can never overspend).
-- When an auto run succeeds, map_run_finish settles to the price of the REAL size: it releases the big hold and
-- reserves + commits the exact amount inside the same transaction (credit functions take the same per-workspace
-- advisory lock, so nobody can spend the freed credits in between). A custom run is charged exactly as before.
-- credit_commit / credit_reserve / credit_release are NOT changed.

-- ---------------------------------------------------------------------------
-- Create entry points that know the size mode. map_run_create stays as it was; these call it.
-- ---------------------------------------------------------------------------
create function public.map_run_create_sized(
  p_workspace  uuid,
  p_user       uuid,
  p_topic      text,
  p_language   text,
  p_locale     text,
  p_size       text,
  p_target_min integer,
  p_target_max integer,
  p_mode       text,
  p_key        text,
  p_project    uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_min integer := p_target_min;
begin
  if p_size is null or p_size not in ('auto', 'custom') then
    raise exception 'invalid_size' using errcode = '22023';
  end if;
  -- auto has no minimum: the base function still wants min >= 10, and V9 ignores the minimum for auto runs
  if p_size = 'auto' then
    v_min := 10;
  end if;
  v_id := public.map_run_create(p_workspace, p_user, p_topic, p_language, p_locale, v_min, p_target_max, p_mode, p_key, p_project);
  update public.map_runs
  set params = params || jsonb_build_object('size', p_size, 'ceiling', p_target_max)
  where id = v_id and not (params ? 'size');
  return v_id;
end;
$$;

create function public.admin_map_run_create_sized(
  p_admin      uuid,
  p_workspace  uuid,
  p_topic      text,
  p_language   text,
  p_locale     text,
  p_size       text,
  p_target_min integer,
  p_target_max integer,
  p_mode       text,
  p_key        text,
  p_ip         text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role    text;
  v_owner   uuid;
  v_existed boolean;
  v_id      uuid;
begin
  select p.role into v_role from public.profiles p where p.user_id = p_admin;
  if v_role is distinct from 'superadmin' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select w.owner_id into v_owner from public.workspaces w where w.id = p_workspace;
  if v_owner is distinct from p_admin then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select exists (select 1 from public.map_runs r where r.workspace_id = p_workspace and r.params ->> 'idempotency_key' = 'admin:' || p_key)
    into v_existed;
  v_id := public.map_run_create_sized(p_workspace, p_admin, p_topic, p_language, p_locale, p_size, p_target_min, p_target_max, p_mode, 'admin:' || p_key);

  if not v_existed then
    insert into public.admin_audit (admin_id, action, target_type, target_id, diff, ip)
    values (p_admin, 'map_run_create', 'map_run', v_id::text,
            jsonb_build_object('workspace_id', p_workspace, 'size', p_size, 'target_max', p_target_max, 'mode', p_mode,
                               'credits_held', public.map_credit_cost(p_target_max)), p_ip);
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- map_run_finish: same behaviour as 0008, plus the settlement of an auto run.
-- ---------------------------------------------------------------------------
create or replace function public.map_run_finish(p_run uuid, p_status text, p_error text default null, p_stats jsonb default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.map_runs;
  v_items  integer;
  v_amount integer;
  v_ledger uuid;
begin
  if p_status not in ('succeeded', 'failed', 'canceled') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  select * into r from public.map_runs where id = p_run for update;
  if not found then
    raise exception 'map_run_not_found' using errcode = 'PM004';
  end if;
  if r.status in ('succeeded', 'failed', 'canceled') then
    return r.status;   -- already final
  end if;

  if r.credit_ledger_id is not null then
    if p_status = 'succeeded' then
      -- auto size: pay for what was really produced, never more than was held
      if r.params ->> 'size' = 'auto' then
        select count(*)::integer into v_items from public.plan_items pi where pi.map_run_id = p_run;
        v_amount := public.map_credit_cost(v_items);
        if v_amount < r.credit_amount then
          perform public.credit_release(r.credit_ledger_id);
          v_ledger := public.credit_reserve(r.workspace_id, v_amount, 'map_run', 'map-run-settle:' || p_run::text, 'map_run', p_run::text);
          update public.map_runs set credit_amount = v_amount, credit_ledger_id = v_ledger where id = p_run;
          r.credit_amount := v_amount;
          r.credit_ledger_id := v_ledger;
        end if;
      end if;
      perform public.credit_commit(r.credit_ledger_id);
    else
      perform public.credit_release(r.credit_ledger_id);
    end if;
  end if;

  update public.map_runs
  set status = p_status, finished_at = now(), last_error = left(p_error, 300),
      stats = coalesce(p_stats, stats), stage = case when p_status = 'succeeded' then 'done' else stage end
  where id = p_run;

  if p_status <> 'succeeded' then
    update public.jobs set state = 'canceled', finished_at = now(), locked_by = null, lease_expires_at = null
    where payload ->> 'mapRunId' = p_run::text and state = 'queued' and type like 'map.%';
  end if;
  return p_status;
end;
$$;

revoke all on function public.map_run_create_sized(uuid, uuid, text, text, text, text, integer, integer, text, text, uuid) from public, anon, authenticated;
revoke all on function public.admin_map_run_create_sized(uuid, uuid, text, text, text, text, integer, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.map_run_create_sized(uuid, uuid, text, text, text, text, integer, integer, text, text, uuid) to service_role;
grant execute on function public.admin_map_run_create_sized(uuid, uuid, text, text, text, text, integer, integer, text, text, text) to service_role;
