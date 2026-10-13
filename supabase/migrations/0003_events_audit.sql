-- 0003_events_audit.sql
-- PinMentor Batch 01C, task 0.5: first-party `events` + append-only `admin_audit`.
-- Requires 0001 + 0002. Paste into Supabase SQL Editor and run once.
--
--  * events: raw product/usage events. Written by the server (service_role) or by DB triggers.
--    Clients have NO access (RLS on, no policies, no grants). Raw rows are kept 14-30 days only
--    (CLAUDE.md); purge_old_events() does the deletion — schedule it (pg_cron or the Phase 1 job
--    runner) with p_days between 14 and 30. Dashboards will read rollup_daily instead (later batch).
--  * admin_audit: who did what to whom. Append-only (UPDATE/DELETE blocked, except the FK
--    "SET NULL" when an admin account is deleted). No client access.
--  * Signup + email-verified events are emitted by the signup triggers, so they cannot be skipped.
--  * Event props must never contain PII (no emails, no content): ids and counts only.

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------
create table public.events (
  id           bigint generated always as identity primary key,
  ts           timestamptz not null default now(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid references auth.users (id) on delete set null,
  name         text not null check (char_length(name) between 1 and 64),
  props        jsonb not null default '{}'::jsonb,
  session_id   text
);
create index events_ts_idx on public.events (ts);
create index events_workspace_ts_idx on public.events (workspace_id, ts);
create index events_name_ts_idx on public.events (name, ts);

alter table public.events enable row level security;   -- no policies: deny-all for anon/authenticated
revoke all on public.events from public, anon, authenticated;

create function public.purge_old_events(p_days integer default 30)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted bigint;
begin
  if p_days is null or p_days < 14 then
    raise exception 'raw events must be kept at least 14 days' using errcode = '22023';
  end if;
  delete from public.events where ts < now() - make_interval(days => p_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.purge_old_events(integer) from public, anon, authenticated;
grant execute on function public.purge_old_events(integer) to service_role;

-- ---------------------------------------------------------------------------
-- admin_audit
-- ---------------------------------------------------------------------------
create table public.admin_audit (
  id          uuid primary key default gen_random_uuid(),
  admin_id    uuid references auth.users (id) on delete set null,
  action      text not null check (char_length(action) between 1 and 80),
  target_type text not null,
  target_id   text,
  diff        jsonb not null default '{}'::jsonb,
  ip          text,
  at          timestamptz not null default now()
);
create index admin_audit_at_idx on public.admin_audit (at desc);
create index admin_audit_admin_idx on public.admin_audit (admin_id, at desc);
create index admin_audit_target_idx on public.admin_audit (target_type, target_id);

create function public.admin_audit_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The FK "ON DELETE SET NULL" (admin account removed) runs this trigger at depth >= 2; allow only that.
  if pg_trigger_depth() >= 2 then
    return case tg_op when 'DELETE' then old else new end;
  end if;
  raise exception 'admin_audit is append-only' using errcode = '42501';
end;
$$;

create trigger admin_audit_guard_upd
  before update on public.admin_audit
  for each row execute function public.admin_audit_guard();

create trigger admin_audit_guard_del
  before delete on public.admin_audit
  for each row execute function public.admin_audit_guard();

alter table public.admin_audit enable row level security;   -- no policies: server-side access only
revoke all on public.admin_audit from public, anon, authenticated;
revoke all on function public.admin_audit_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Signup triggers now also emit `signup` and `email_verified` (replaces the 0001 versions).
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws uuid;
begin
  insert into public.profiles (user_id) values (new.id) on conflict do nothing;

  insert into public.workspaces (name, owner_id)
  values ('My workspace', new.id)
  returning id into ws;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (ws, new.id, 'owner');

  insert into public.events (workspace_id, user_id, name) values (ws, new.id, 'signup');

  if new.email_confirmed_at is not null then
    perform public.grant_trial(ws, new.email);
    insert into public.events (workspace_id, user_id, name) values (ws, new.id, 'email_verified');
  end if;

  return new;
end;
$$;

create or replace function public.handle_user_confirmed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws uuid;
begin
  select w.id into ws
  from public.workspaces w
  where w.owner_id = new.id
  order by w.created_at
  limit 1;

  if ws is not null then
    perform public.grant_trial(ws, new.email);
    insert into public.events (workspace_id, user_id, name) values (ws, new.id, 'email_verified');
  end if;

  return new;
end;
$$;
