-- 0002_credit_ledger.sql
-- PinMentor Batch 01C, task 0.4: credit ledger + transactional, idempotent reserve/commit/release.
-- Requires 0001. Paste into Supabase SQL Editor and run once.
--
-- Model
--   * One row per credit movement. `delta` > 0 = credits in (grant/purchase), < 0 = credits out.
--   * reserve  -> row with delta = -amount, status 'held'       (credits are set aside, balance drops)
--   * commit   -> same row, status 'committed'                  (the charge becomes final)
--   * release  -> same row, status 'released'                   (credits return; row no longer counts)
--   * adjust   -> grant / revoke, inserted directly as 'committed'
--   * available = SUM(delta) over rows with status in ('held','committed')
--   * Rows are immutable except the one-way transition held -> committed|released (trigger-enforced);
--     rows can never be deleted directly (they go away only with their workspace/user: FK cascade).
--   * Every call is idempotent via `idempotency_key` (globally unique). Same key + same arguments =
--     same result, no second charge. Same key + different arguments = error PM002.
--   * All writes for one workspace are serialised with a per-workspace advisory lock, so parallel
--     reserves can never overdraw the balance.
--
-- Error codes raised (SQLSTATE -> meaning): PM001 insufficient_credits, PM002 idempotency_conflict,
-- PM003 invalid_state (e.g. commit after release), PM004 reservation_not_found, 22023 invalid argument.
--
-- Only the server (service_role) may call the functions. Workspace members can SELECT their ledger.

create table public.credit_ledger (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  delta           integer not null check (delta <> 0),
  reason          text not null check (char_length(btrim(reason)) between 1 and 200),
  ref_type        text,
  ref_id          text,
  idempotency_key text not null unique check (char_length(idempotency_key) between 1 and 200),
  status          text not null check (status in ('held','committed','released')),
  created_at      timestamptz not null default now(),
  settled_at      timestamptz
);
create index credit_ledger_workspace_status_idx on public.credit_ledger (workspace_id, status);
create index credit_ledger_ref_idx on public.credit_ledger (ref_type, ref_id);

-- ---------------------------------------------------------------------------
-- Append-only guard
-- ---------------------------------------------------------------------------
create function public.credit_ledger_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    -- Direct DELETE runs this trigger at depth 1; an FK cascade (workspace/user deletion) at depth >= 2.
    if pg_trigger_depth() < 2 then
      raise exception 'credit_ledger is append-only' using errcode = '42501';
    end if;
    return old;
  end if;

  -- 1) nothing but status / settled_at may ever change
  if (new.id, new.workspace_id, new.delta, new.reason, new.ref_type, new.ref_id, new.idempotency_key, new.created_at)
     is distinct from
     (old.id, old.workspace_id, old.delta, old.reason, old.ref_type, old.ref_id, old.idempotency_key, old.created_at) then
    raise exception 'credit_ledger rows are immutable' using errcode = '42501';
  end if;

  -- 2) status moves one way only: held -> committed | released
  if old.status <> 'held' or new.status not in ('committed', 'released') then
    raise exception 'credit_ledger: illegal status change % -> %', old.status, new.status using errcode = 'PM003';
  end if;

  return new;
end;
$$;

create trigger credit_ledger_guard_upd
  before update on public.credit_ledger
  for each row execute function public.credit_ledger_guard();

create trigger credit_ledger_guard_del
  before delete on public.credit_ledger
  for each row execute function public.credit_ledger_guard();

-- ---------------------------------------------------------------------------
-- Balance (server only)
-- ---------------------------------------------------------------------------
create function public.credit_balance(p_workspace uuid)
returns table (available integer, held integer)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(sum(l.delta) filter (where l.status in ('held', 'committed')), 0)::integer,
    coalesce(-sum(l.delta) filter (where l.status = 'held'), 0)::integer
  from public.credit_ledger l
  where l.workspace_id = p_workspace;
$$;

-- ---------------------------------------------------------------------------
-- Reserve
-- ---------------------------------------------------------------------------
create function public.credit_reserve(
  p_workspace uuid,
  p_amount    integer,
  p_reason    text,
  p_key       text,
  p_ref_type  text default null,
  p_ref_id    text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing  public.credit_ledger;
  v_available integer;
  v_id        uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if p_key is null or btrim(p_key) = '' then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('credit:' || p_workspace::text, 0));

  select * into v_existing from public.credit_ledger where idempotency_key = p_key;
  if found then
    if v_existing.workspace_id <> p_workspace or v_existing.delta <> -p_amount then
      raise exception 'idempotency_conflict' using errcode = 'PM002';
    end if;
    return v_existing.id;
  end if;

  select coalesce(sum(l.delta), 0)::integer into v_available
  from public.credit_ledger l
  where l.workspace_id = p_workspace and l.status in ('held', 'committed');

  if v_available < p_amount then
    raise exception 'insufficient_credits' using errcode = 'PM001';
  end if;

  insert into public.credit_ledger (workspace_id, delta, reason, ref_type, ref_id, idempotency_key, status)
  values (p_workspace, -p_amount, p_reason, p_ref_type, p_ref_id, p_key, 'held')
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Commit (idempotent: committing twice never charges twice)
-- ---------------------------------------------------------------------------
create function public.credit_commit(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.credit_ledger;
begin
  select * into v from public.credit_ledger where id = p_id;
  if not found then
    raise exception 'reservation_not_found' using errcode = 'PM004';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('credit:' || v.workspace_id::text, 0));

  select * into v from public.credit_ledger where id = p_id for update;

  if v.status = 'held' then
    update public.credit_ledger set status = 'committed', settled_at = now() where id = p_id;
    return 'committed';
  elsif v.status = 'committed' then
    return 'committed';
  end if;

  raise exception 'reservation_released' using errcode = 'PM003';
end;
$$;

-- ---------------------------------------------------------------------------
-- Release (idempotent; a committed charge cannot be released)
-- ---------------------------------------------------------------------------
create function public.credit_release(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.credit_ledger;
begin
  select * into v from public.credit_ledger where id = p_id;
  if not found then
    raise exception 'reservation_not_found' using errcode = 'PM004';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('credit:' || v.workspace_id::text, 0));

  select * into v from public.credit_ledger where id = p_id for update;

  if v.status = 'held' then
    update public.credit_ledger set status = 'released', settled_at = now() where id = p_id;
    return 'released';
  elsif v.status = 'released' then
    return 'released';
  end if;

  raise exception 'reservation_committed' using errcode = 'PM003';
end;
$$;

-- ---------------------------------------------------------------------------
-- Adjust: grant (delta > 0) or revoke (delta < 0, never below zero). Final immediately.
-- ---------------------------------------------------------------------------
create function public.credit_adjust(
  p_workspace uuid,
  p_delta     integer,
  p_reason    text,
  p_key       text,
  p_ref_type  text default null,
  p_ref_id    text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing  public.credit_ledger;
  v_available integer;
  v_id        uuid;
begin
  if p_delta is null or p_delta = 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if p_key is null or btrim(p_key) = '' then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('credit:' || p_workspace::text, 0));

  select * into v_existing from public.credit_ledger where idempotency_key = p_key;
  if found then
    if v_existing.workspace_id <> p_workspace or v_existing.delta <> p_delta then
      raise exception 'idempotency_conflict' using errcode = 'PM002';
    end if;
    return v_existing.id;
  end if;

  if p_delta < 0 then
    select coalesce(sum(l.delta), 0)::integer into v_available
    from public.credit_ledger l
    where l.workspace_id = p_workspace and l.status in ('held', 'committed');

    if v_available + p_delta < 0 then
      raise exception 'insufficient_credits' using errcode = 'PM001';
    end if;
  end if;

  insert into public.credit_ledger (workspace_id, delta, reason, ref_type, ref_id, idempotency_key, status, settled_at)
  values (p_workspace, p_delta, p_reason, p_ref_type, p_ref_id, p_key, 'committed', now())
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Trial grant now lands in the ledger (idempotent key 'trial:<workspace>').
-- Replaces the 0001 version; same signature, same 30-credit size.
-- ---------------------------------------------------------------------------
create or replace function public.grant_trial(p_workspace uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.trials (workspace_id, granted_credits, email_hash)
  values (
    p_workspace,
    30,
    encode(sha256(convert_to(lower(btrim(coalesce(p_email, ''))), 'utf8')), 'hex')
  )
  on conflict (workspace_id) do nothing;

  perform public.credit_adjust(p_workspace, 30, 'trial_grant', 'trial:' || p_workspace::text, 'trial', p_workspace::text);
end;
$$;

-- Backfill: trials granted under 0001 get their ledger row.
insert into public.credit_ledger (workspace_id, delta, reason, ref_type, ref_id, idempotency_key, status, settled_at)
select t.workspace_id, t.granted_credits, 'trial_grant', 'trial', t.workspace_id::text,
       'trial:' || t.workspace_id::text, 'committed', t.granted_at
from public.trials t
where t.granted_credits > 0
on conflict (idempotency_key) do nothing;

-- ---------------------------------------------------------------------------
-- Privileges + RLS
-- ---------------------------------------------------------------------------
revoke all on public.credit_ledger from public, anon, authenticated;
grant select on public.credit_ledger to authenticated;

alter table public.credit_ledger enable row level security;

create policy credit_ledger_select_member on public.credit_ledger
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

revoke all on function public.credit_balance(uuid)                                             from public, anon, authenticated;
revoke all on function public.credit_reserve(uuid, integer, text, text, text, text)            from public, anon, authenticated;
revoke all on function public.credit_commit(uuid)                                              from public, anon, authenticated;
revoke all on function public.credit_release(uuid)                                             from public, anon, authenticated;
revoke all on function public.credit_adjust(uuid, integer, text, text, text, text)            from public, anon, authenticated;

grant execute on function public.credit_balance(uuid)                                          to service_role;
grant execute on function public.credit_reserve(uuid, integer, text, text, text, text)         to service_role;
grant execute on function public.credit_commit(uuid)                                           to service_role;
grant execute on function public.credit_release(uuid)                                          to service_role;
grant execute on function public.credit_adjust(uuid, integer, text, text, text, text)         to service_role;

-- credit_ledger_guard() is a trigger function; nobody needs EXECUTE on it.
revoke all on function public.credit_ledger_guard() from public, anon, authenticated;
