-- 0006_jobs.sql
-- PinMentor Batch 02, part 2: job queue (PLAN §12): FOR UPDATE SKIP LOCKED claiming, visibility-timeout leases,
-- retries with backoff, dead-letter state, watchdog, per-provider concurrency, credit hold/commit/release tied to
-- the job, and audited admin retry/cancel. Requires 0001-0005. Paste into Supabase SQL Editor and run once.
--
-- Lifecycle   queued -> running -> succeeded
--                          |-> queued (failed attempt, retry after backoff)
--                          |-> dead   (attempts exhausted or non-retryable) = the dead-letter queue, visible in /admin/jobs
--             queued | dead -> canceled (admin)         dead -> queued (admin retry, re-reserves credits)
--
-- Credits: job_enqueue reserves credits (credit_rates.credits for p_credit_action) IN THE SAME TRANSACTION as the
-- job row (no job without its hold; no hold without a job). job_complete commits the hold, job_fail (final) /
-- cancel / watchdog release it. Every call is idempotent; a worker that lost its lease cannot complete or fail a job
-- (SQLSTATE PM003), so a hold can never be committed twice or by a stale worker.
--
-- Error codes: PM001 insufficient_credits (from the ledger), PM002 idempotency_conflict, PM003 invalid_state /
-- job_not_owned, PM004 job_not_found, 42501 forbidden, 22023 invalid argument.
--
-- Only service_role may call these functions; clients have no access to the tables (RLS on, no policies).

create table public.jobs (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  type             text not null check (type ~ '^[a-z][a-z0-9_.]{1,63}$'),
  payload          jsonb not null default '{}'::jsonb check (octet_length(payload::text) <= 100000),
  state            text not null default 'queued' check (state in ('queued', 'running', 'succeeded', 'dead', 'canceled')),
  priority         integer not null default 0,
  run_at           timestamptz not null default now(),
  attempts         integer not null default 0 check (attempts >= 0),
  max_attempts     integer not null default 3 check (max_attempts between 1 and 10),
  retry_count      integer not null default 0 check (retry_count >= 0),
  provider         text check (provider in ('anthropic', 'openai', 'gemini')),   -- for per-provider concurrency limits
  locked_by        text,
  lease_expires_at timestamptz,
  started_at       timestamptz,
  idempotency_key  text not null unique check (char_length(idempotency_key) between 1 and 200),
  parent_job_id    uuid references public.jobs (id) on delete cascade,
  stage            text,
  credit_amount    integer not null default 0 check (credit_amount >= 0),
  credit_ledger_id uuid,
  result           jsonb,
  last_error       text,
  last_error_code  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  finished_at      timestamptz,
  check (state <> 'running' or (locked_by is not null and lease_expires_at is not null))
);

create index jobs_claim_idx on public.jobs (priority desc, run_at, created_at) where state = 'queued';
create index jobs_running_lease_idx on public.jobs (lease_expires_at) where state = 'running';
create index jobs_running_provider_idx on public.jobs (provider) where state = 'running';
create index jobs_workspace_created_idx on public.jobs (workspace_id, created_at desc);
create index jobs_state_created_idx on public.jobs (state, created_at desc);
create index jobs_parent_idx on public.jobs (parent_job_id) where parent_job_id is not null;

alter table public.llm_calls
  add constraint llm_calls_job_fk foreign key (job_id) references public.jobs (id) on delete set null;
create index llm_calls_job_idx on public.llm_calls (job_id) where job_id is not null;

create function public.jobs_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger jobs_touch_trg
  before update on public.jobs
  for each row execute function public.jobs_touch();

-- ---------------------------------------------------------------------------
-- Backoff: 30s * 2^(attempt-1), capped at 1h, + up to 20% jitter.
-- ---------------------------------------------------------------------------
create function public.job_backoff_seconds(p_attempt integer)
returns integer
language sql
volatile
set search_path = ''
as $$
  select (least(3600, 30 * power(2, greatest(coalesce(p_attempt, 1), 1) - 1)) * (1 + random() * 0.2))::integer;
$$;

-- ---------------------------------------------------------------------------
-- Enqueue (idempotent on p_key; reserves credits atomically)
-- ---------------------------------------------------------------------------
create function public.job_enqueue(
  p_workspace     uuid,
  p_type          text,
  p_payload       jsonb,
  p_key           text,
  p_credit_action text        default null,
  p_run_at        timestamptz default now(),
  p_max_attempts  integer     default 3,
  p_priority      integer     default 0,
  p_provider      text        default null,
  p_parent        uuid        default null,
  p_stage         text        default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.jobs;
  v_id       uuid := gen_random_uuid();
  v_amount   integer := 0;
  v_ledger   uuid;
begin
  if p_key is null or btrim(p_key) = '' or char_length(p_key) > 200 then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;
  if p_max_attempts is null or p_max_attempts not between 1 and 10 then
    raise exception 'invalid_max_attempts' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('job:' || p_key, 0));

  select * into v_existing from public.jobs where idempotency_key = p_key;
  if found then
    if v_existing.workspace_id <> p_workspace or v_existing.type <> p_type then
      raise exception 'idempotency_conflict' using errcode = 'PM002';
    end if;
    return v_existing.id;
  end if;

  if p_credit_action is not null then
    select r.credits into v_amount from public.credit_rates r where r.action = p_credit_action;
    if not found then
      raise exception 'unknown_credit_action' using errcode = '22023';
    end if;
    if v_amount > 0 then
      v_ledger := public.credit_reserve(p_workspace, v_amount, 'job:' || p_type, 'job-reserve:' || p_key, 'job', v_id::text);
    end if;
  end if;

  insert into public.jobs (id, workspace_id, type, payload, run_at, max_attempts, priority, provider,
                           idempotency_key, parent_job_id, stage, credit_amount, credit_ledger_id)
  values (v_id, p_workspace, p_type, coalesce(p_payload, '{}'::jsonb), coalesce(p_run_at, now()), p_max_attempts,
          coalesce(p_priority, 0), p_provider, p_key, p_parent, p_stage, v_amount, v_ledger);

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Claim: SKIP LOCKED + per-provider concurrency. Claims are serialised by one advisory lock so the
-- per-provider running count cannot be overshot by two claimers racing.
-- p_provider_limits example: {"anthropic": 4, "openai": 4, "gemini": 4}. A provider without a limit is unlimited.
-- ---------------------------------------------------------------------------
create function public.job_claim(
  p_worker          text,
  p_limit           integer default 5,
  p_lease_seconds   integer default 90,
  p_provider_limits jsonb   default '{}'::jsonb
)
returns setof public.jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  r         public.jobs;
  v_job     public.jobs;
  v_taken   integer := 0;
  v_running integer;
  v_limit   integer;
begin
  if p_worker is null or btrim(p_worker) = '' then
    raise exception 'invalid_worker' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 5 or p_lease_seconds > 900 then
    raise exception 'invalid_lease' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('job_claim', 0));

  for r in
    select j.*
    from public.jobs j
    where j.state = 'queued' and j.run_at <= now()
    order by j.priority desc, j.run_at, j.created_at
    for update skip locked
    limit greatest(p_limit * 10, 20)
  loop
    exit when v_taken >= p_limit;

    if r.provider is not null and p_provider_limits ? r.provider then
      v_limit := (p_provider_limits ->> r.provider)::integer;
      select count(*) into v_running from public.jobs x where x.state = 'running' and x.provider = r.provider;
      if v_running >= v_limit then
        continue;
      end if;
    end if;

    update public.jobs
    set state = 'running',
        attempts = attempts + 1,
        locked_by = p_worker,
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        started_at = now()
    where id = r.id
    returning * into v_job;

    v_taken := v_taken + 1;
    return next v_job;
  end loop;

  return;
end;
$$;

-- ---------------------------------------------------------------------------
-- Heartbeat: a long handler extends its lease. Returns false if the worker no longer owns the job.
-- ---------------------------------------------------------------------------
create function public.job_heartbeat(p_job uuid, p_worker text, p_extend_seconds integer default 90)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  update public.jobs
  set lease_expires_at = now() + make_interval(secs => least(greatest(coalesce(p_extend_seconds, 90), 5), 900))
  where id = p_job and state = 'running' and locked_by = p_worker;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- Complete: commits the credit hold. Replay-safe: completing an already-succeeded job is a no-op.
-- ---------------------------------------------------------------------------
create function public.job_complete(p_job uuid, p_worker text, p_result jsonb default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.jobs;
begin
  select * into v from public.jobs where id = p_job for update;
  if not found then
    raise exception 'job_not_found' using errcode = 'PM004';
  end if;

  if v.state = 'succeeded' then
    return 'succeeded';
  end if;
  if v.state <> 'running' or v.locked_by is distinct from p_worker then
    raise exception 'job_not_owned' using errcode = 'PM003';
  end if;

  if v.credit_ledger_id is not null then
    perform public.credit_commit(v.credit_ledger_id);
  end if;

  update public.jobs
  set state = 'succeeded', result = p_result, finished_at = now(),
      locked_by = null, lease_expires_at = null, last_error = null, last_error_code = null
  where id = p_job;

  return 'succeeded';
end;
$$;

-- ---------------------------------------------------------------------------
-- Fail: retry with backoff while attempts remain and the error is retryable; otherwise dead-letter + release credits.
-- ---------------------------------------------------------------------------
create function public.job_fail(
  p_job                uuid,
  p_worker             text,
  p_error              text,
  p_error_code         text    default null,
  p_retryable          boolean default true,
  p_retry_after_seconds integer default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v       public.jobs;
  v_err   text := left(coalesce(p_error, ''), 1000);
  v_delay integer;
begin
  select * into v from public.jobs where id = p_job for update;
  if not found then
    raise exception 'job_not_found' using errcode = 'PM004';
  end if;
  if v.state <> 'running' or v.locked_by is distinct from p_worker then
    raise exception 'job_not_owned' using errcode = 'PM003';
  end if;

  if coalesce(p_retryable, true) and v.attempts < v.max_attempts then
    v_delay := coalesce(least(greatest(p_retry_after_seconds, 0), 86400), public.job_backoff_seconds(v.attempts));
    update public.jobs
    set state = 'queued', run_at = now() + make_interval(secs => v_delay),
        locked_by = null, lease_expires_at = null,
        last_error = v_err, last_error_code = p_error_code
    where id = p_job;
    return 'queued';
  end if;

  if v.credit_ledger_id is not null then
    perform public.credit_release(v.credit_ledger_id);
  end if;

  update public.jobs
  set state = 'dead', finished_at = now(), locked_by = null, lease_expires_at = null,
      last_error = v_err, last_error_code = p_error_code
  where id = p_job;
  return 'dead';
end;
$$;

-- ---------------------------------------------------------------------------
-- Watchdog (PLAN §12): jobs whose lease expired are re-queued (or dead-lettered), and credit holds that belong to a
-- job that is no longer live are released. Run it every tick; it is idempotent.
-- ---------------------------------------------------------------------------
create function public.job_watchdog(p_orphan_hold_hours integer default 24)
returns table (requeued integer, dead integer, released_holds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  r         public.jobs;
  l         record;
  v_req     integer := 0;
  v_dead    integer := 0;
  v_rel     integer := 0;
begin
  for r in
    select j.* from public.jobs j
    where j.state = 'running' and j.lease_expires_at < now()
    for update skip locked
  loop
    if r.attempts < r.max_attempts then
      update public.jobs
      set state = 'queued', run_at = now() + make_interval(secs => public.job_backoff_seconds(r.attempts)),
          locked_by = null, lease_expires_at = null,
          last_error = 'lease expired (worker stopped or timed out)', last_error_code = 'lease_expired'
      where id = r.id;
      v_req := v_req + 1;
    else
      if r.credit_ledger_id is not null then
        perform public.credit_release(r.credit_ledger_id);
      end if;
      update public.jobs
      set state = 'dead', finished_at = now(), locked_by = null, lease_expires_at = null,
          last_error = 'lease expired (worker stopped or timed out)', last_error_code = 'lease_expired'
      where id = r.id;
      v_dead := v_dead + 1;
    end if;
  end loop;

  for l in
    select cl.id
    from public.credit_ledger cl
    where cl.status = 'held'
      and cl.ref_type = 'job'
      and cl.created_at < now() - make_interval(hours => greatest(coalesce(p_orphan_hold_hours, 24), 1))
      and not exists (
        select 1 from public.jobs j
        where j.id::text = cl.ref_id and j.credit_ledger_id = cl.id and j.state in ('queued', 'running')
      )
  loop
    begin
      perform public.credit_release(l.id);
      v_rel := v_rel + 1;
    exception when sqlstate 'PM003' then
      null;   -- committed concurrently: nothing to release
    end;
  end loop;

  return query select v_req, v_dead, v_rel;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cancel / retry-dead (internal building blocks; the admin_* wrappers below add role check + audit)
-- ---------------------------------------------------------------------------
create function public.job_cancel(p_job uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.jobs;
begin
  select * into v from public.jobs where id = p_job for update;
  if not found then
    raise exception 'job_not_found' using errcode = 'PM004';
  end if;
  if v.state not in ('queued', 'dead') then
    raise exception 'job_not_cancelable' using errcode = 'PM003';
  end if;

  if v.credit_ledger_id is not null then
    perform public.credit_release(v.credit_ledger_id);
  end if;

  update public.jobs set state = 'canceled', finished_at = now(), locked_by = null, lease_expires_at = null
  where id = p_job;
  return 'canceled';
end;
$$;

create function public.job_retry_dead(p_job uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v        public.jobs;
  v_ledger uuid;
  v_retry  integer;
begin
  select * into v from public.jobs where id = p_job for update;
  if not found then
    raise exception 'job_not_found' using errcode = 'PM004';
  end if;
  if v.state <> 'dead' then
    raise exception 'job_not_retryable' using errcode = 'PM003';
  end if;

  v_retry := v.retry_count + 1;
  if v.credit_amount > 0 then
    -- the original hold was released when the job died: reserve again (raises PM001 if the balance no longer covers it)
    v_ledger := public.credit_reserve(v.workspace_id, v.credit_amount, 'job:' || v.type,
                                      'job-reserve:' || v.idempotency_key || ':r' || v_retry, 'job', v.id::text);
  end if;

  update public.jobs
  set state = 'queued', attempts = 0, retry_count = v_retry, run_at = now(), finished_at = null,
      locked_by = null, lease_expires_at = null, credit_ledger_id = v_ledger
  where id = p_job;
  return 'queued';
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin wrappers: role check in the database + admin_audit row in the same transaction.
-- Retry/cancel: superadmin or support (PLAN §10.1: support may retry). Test jobs: superadmin, own workspace only.
-- ---------------------------------------------------------------------------
create function public.admin_job_retry(p_admin uuid, p_job uuid, p_ip text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role   text;
  v        public.jobs;
  v_result text;
begin
  select p.role into v_role from public.profiles p where p.user_id = p_admin;
  if v_role is distinct from 'superadmin' and v_role is distinct from 'support' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v from public.jobs where id = p_job;
  v_result := public.job_retry_dead(p_job);

  insert into public.admin_audit (admin_id, action, target_type, target_id, diff, ip)
  values (p_admin, 'job_retry', 'job', p_job::text,
          jsonb_build_object('type', v.type, 'workspace_id', v.workspace_id, 'state_before', v.state,
                             'state_after', v_result, 'credit_amount', v.credit_amount, 'last_error_code', v.last_error_code),
          p_ip);
  return v_result;
end;
$$;

create function public.admin_job_cancel(p_admin uuid, p_job uuid, p_ip text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role   text;
  v        public.jobs;
  v_result text;
begin
  select p.role into v_role from public.profiles p where p.user_id = p_admin;
  if v_role is distinct from 'superadmin' and v_role is distinct from 'support' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v from public.jobs where id = p_job;
  v_result := public.job_cancel(p_job);

  insert into public.admin_audit (admin_id, action, target_type, target_id, diff, ip)
  values (p_admin, 'job_cancel', 'job', p_job::text,
          jsonb_build_object('type', v.type, 'workspace_id', v.workspace_id, 'state_before', v.state,
                             'state_after', v_result, 'credit_amount', v.credit_amount),
          p_ip);
  return v_result;
end;
$$;

create function public.admin_enqueue_test_job(
  p_admin     uuid,
  p_workspace uuid,
  p_key       text,
  p_mode      text default 'llm',
  p_ip        text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role    text;
  v_owner   uuid;
  v_key     text;
  v_existed boolean;
  v_id      uuid;
begin
  select p.role into v_role from public.profiles p where p.user_id = p_admin;
  if v_role is distinct from 'superadmin' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select w.owner_id into v_owner from public.workspaces w where w.id = p_workspace;
  if v_owner is distinct from p_admin then
    raise exception 'forbidden' using errcode = '42501';   -- an admin may only spend their OWN workspace's credits
  end if;
  if p_mode not in ('llm', 'ok', 'fail', 'fail_permanent') then
    raise exception 'invalid_mode' using errcode = '22023';
  end if;
  if p_key is null or btrim(p_key) = '' then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;

  v_key := 'admin-test:' || p_key;
  select exists (select 1 from public.jobs j where j.idempotency_key = v_key) into v_existed;

  if p_mode = 'llm' then
    v_id := public.job_enqueue(p_workspace, 'test.llm_echo', jsonb_build_object('prompt', 'ping'), v_key, 'test_job', now(), 3, 0, null);
  else
    v_id := public.job_enqueue(p_workspace, 'test.noop', jsonb_build_object('mode', p_mode), v_key, null, now(),
                               case when p_mode = 'fail' then 2 else 1 end, 0, null);
  end if;

  if not v_existed then
    insert into public.admin_audit (admin_id, action, target_type, target_id, diff, ip)
    values (p_admin, 'job_enqueue_test', 'job', v_id::text,
            jsonb_build_object('mode', p_mode, 'workspace_id', p_workspace), p_ip);
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Read helpers for /admin/jobs
-- ---------------------------------------------------------------------------
create function public.admin_job_counts()
returns table (state text, jobs bigint, oldest_run_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select j.state, count(*), min(j.run_at)
  from public.jobs j
  group by j.state
  order by j.state;
$$;

-- ---------------------------------------------------------------------------
-- Retention: finished successful/canceled jobs only (dead-letter rows stay until an admin handles them).
-- ---------------------------------------------------------------------------
create function public.purge_old_jobs(p_days integer default 30)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted bigint;
begin
  if p_days is null or p_days < 7 then
    raise exception 'jobs must be kept at least 7 days' using errcode = '22023';
  end if;
  delete from public.jobs
  where state in ('succeeded', 'canceled') and finished_at < now() - make_interval(days => p_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges + RLS
-- ---------------------------------------------------------------------------
alter table public.jobs enable row level security;   -- no policies: server-only
revoke all on public.jobs from public, anon, authenticated;

revoke all on function public.jobs_touch()                                                              from public, anon, authenticated;
revoke all on function public.job_backoff_seconds(integer)                                              from public, anon, authenticated;
revoke all on function public.job_enqueue(uuid, text, jsonb, text, text, timestamptz, integer, integer, text, uuid, text) from public, anon, authenticated;
revoke all on function public.job_claim(text, integer, integer, jsonb)                                  from public, anon, authenticated;
revoke all on function public.job_heartbeat(uuid, text, integer)                                        from public, anon, authenticated;
revoke all on function public.job_complete(uuid, text, jsonb)                                           from public, anon, authenticated;
revoke all on function public.job_fail(uuid, text, text, text, boolean, integer)                        from public, anon, authenticated;
revoke all on function public.job_watchdog(integer)                                                     from public, anon, authenticated;
revoke all on function public.job_cancel(uuid)                                                          from public, anon, authenticated;
revoke all on function public.job_retry_dead(uuid)                                                      from public, anon, authenticated;
revoke all on function public.admin_job_retry(uuid, uuid, text)                                         from public, anon, authenticated;
revoke all on function public.admin_job_cancel(uuid, uuid, text)                                        from public, anon, authenticated;
revoke all on function public.admin_enqueue_test_job(uuid, uuid, text, text, text)                      from public, anon, authenticated;
revoke all on function public.admin_job_counts()                                                        from public, anon, authenticated;
revoke all on function public.purge_old_jobs(integer)                                                   from public, anon, authenticated;

grant execute on function public.job_enqueue(uuid, text, jsonb, text, text, timestamptz, integer, integer, text, uuid, text) to service_role;
grant execute on function public.job_claim(text, integer, integer, jsonb)                               to service_role;
grant execute on function public.job_heartbeat(uuid, text, integer)                                     to service_role;
grant execute on function public.job_complete(uuid, text, jsonb)                                        to service_role;
grant execute on function public.job_fail(uuid, text, text, text, boolean, integer)                     to service_role;
grant execute on function public.job_watchdog(integer)                                                  to service_role;
grant execute on function public.job_cancel(uuid)                                                       to service_role;
grant execute on function public.job_retry_dead(uuid)                                                   to service_role;
grant execute on function public.admin_job_retry(uuid, uuid, text)                                      to service_role;
grant execute on function public.admin_job_cancel(uuid, uuid, text)                                     to service_role;
grant execute on function public.admin_enqueue_test_job(uuid, uuid, text, text, text)                   to service_role;
grant execute on function public.admin_job_counts()                                                     to service_role;
grant execute on function public.purge_old_jobs(integer)                                                to service_role;
