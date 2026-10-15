-- rls_0005_0006.sql — tests for migration 0005 (model registry, routes, cost log, budget guard)
--                    and 0006 (job queue, credit hold/commit/release per job, watchdog, admin wrappers, permissions)
--
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0005 and 0006 are applied).
-- It creates 3 throw-away users (fixed UUIDs; A = user, B = superadmin, C = support), exercises everything as the
-- relevant roles, restores/deletes everything it touched, and ends with ONE result table. Safe to re-run.
-- It briefly flips a few global settings (a model's enabled flag, the two LLM feature flags) and puts them back
-- right after each check. Do not run it while real LLM traffic is flowing.
-- (The parallel-claim race test is a shell script: supabase/tests/jobs_concurrency.sh.)
--
-- EXPECTED OUTPUT: every row has pass = true and the last row reads
--   ALL CHECKS  |  <N> of <N> passed  |  (blank) | (blank) | true
-- Any `false` row = a real bug -> do not ship; send me the table.

reset role;

-- leftovers from an earlier (aborted) run
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where target_id in (select id::text from public.jobs where workspace_id in (
    select id from public.workspaces where owner_id in (
      'a5a5a5a5-0000-0000-0000-000000000001','b5b5b5b5-0000-0000-0000-000000000002','c5c5c5c5-0000-0000-0000-000000000003')));
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from public.llm_routes where task in ('zz_test_route', 'zz_bad_route');
delete from public.model_registry where key = 'test.noprice';
delete from auth.users where id in (
  'a5a5a5a5-0000-0000-0000-000000000001',
  'b5b5b5b5-0000-0000-0000-000000000002',
  'c5c5c5c5-0000-0000-0000-000000000003');

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;

create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

-- original values of the global settings this test touches
create temp table t_orig as
  select key, enabled, rules from public.feature_flags where key in ('llm_kill_switch', 'llm_budget_guard');

-- ---------------------------------------------------------------------------
-- Setup: A (user), B (superadmin), C (support); all confirmed -> 30 trial credits each
-- ---------------------------------------------------------------------------
insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('a5a5a5a5-0000-0000-0000-000000000001','authenticated','authenticated','a5@example.test', now()),
  ('b5b5b5b5-0000-0000-0000-000000000002','authenticated','authenticated','b5@example.test', now()),
  ('c5c5c5c5-0000-0000-0000-000000000003','authenticated','authenticated','c5@example.test', now());
update public.profiles set role = 'superadmin' where user_id = 'b5b5b5b5-0000-0000-0000-000000000002';
update public.profiles set role = 'support'    where user_id = 'c5c5c5c5-0000-0000-0000-000000000003';

create temp table t_ws as
  select owner_id as uid, id as ws from public.workspaces
  where owner_id in ('a5a5a5a5-0000-0000-0000-000000000001','b5b5b5b5-0000-0000-0000-000000000002','c5c5c5c5-0000-0000-0000-000000000003');
grant select on t_ws to anon, authenticated, service_role;
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to anon, authenticated, service_role;

create function pg_temp.wsa() returns uuid language sql as $$ select ws from t_ws where uid = 'a5a5a5a5-0000-0000-0000-000000000001' $$;
create function pg_temp.wsb() returns uuid language sql as $$ select ws from t_ws where uid = 'b5b5b5b5-0000-0000-0000-000000000002' $$;
create function pg_temp.wsc() returns uuid language sql as $$ select ws from t_ws where uid = 'c5c5c5c5-0000-0000-0000-000000000003' $$;
create function pg_temp.j(k text) returns uuid language sql as $$ select v from t_ids where k = $1 $$;
create function pg_temp.bal(w uuid) returns text language sql as $$ select available || '/' || held from public.credit_balance(w) $$;
create function pg_temp.js(id uuid) returns text language sql as $$ select state || '/' || attempts from public.jobs where jobs.id = $1 $$;
create function pg_temp.hold(id uuid) returns text language sql as $$
  select l.status from public.jobs j join public.credit_ledger l on l.id = j.credit_ledger_id where j.id = $1 $$;
create function pg_temp.lease(id uuid) returns timestamptz language sql as $$ select lease_expires_at from public.jobs where jobs.id = $1 $$;
create function pg_temp.errlen(id uuid) returns text language sql as $$ select char_length(last_error)::text from public.jobs where jobs.id = $1 $$;
create function pg_temp.retries(id uuid) returns text language sql as $$ select retry_count::text from public.jobs where jobs.id = $1 $$;
create function pg_temp.ledger_states(id uuid) returns text language sql as $$
  select string_agg(l.status, ',' order by l.status) from public.credit_ledger l where l.ref_type = 'job' and l.ref_id = $1::text $$;
create function pg_temp.audit_n(a text, id uuid) returns text language sql as $$
  select count(*)::text from public.admin_audit where action = $1 and target_id = $2::text $$;
grant execute on function pg_temp.wsa(), pg_temp.wsb(), pg_temp.wsc(), pg_temp.j(text), pg_temp.bal(uuid), pg_temp.js(uuid), pg_temp.hold(uuid),
  pg_temp.lease(uuid), pg_temp.errlen(uuid), pg_temp.retries(uuid), pg_temp.ledger_states(uuid), pg_temp.audit_n(text, uuid)
  to anon, authenticated, service_role;

-- ===========================================================================
-- 0005  REGISTRY / PRICES / ROUTES
-- ===========================================================================
insert into t_results (who, test, actual, expected) values
  ('registry', 'cheap route order (haiku, flash-lite, luna)',
     (select string_agg(model_key, ',' order by pos) from public.llm_route_models('facet_generation')),
     'anthropic.haiku-5-5,gemini.3-5-flash-lite,openai.gpt-6-luna'),
  ('registry', 'mid route order (sonnet, 3.8 flash, 6.1 sol)',
     (select string_agg(model_key, ',' order by pos) from public.llm_route_models('intent_judge')),
     'anthropic.sonnet-5-5,gemini.3-8-flash,openai.gpt-6-1-sol'),
  ('registry', 'unknown task has no route',
     (select count(*)::text from public.llm_route_models('no_such_task')), '0'),
  ('registry', 'Gemini 3.8 Flash uses the intro price today',
     (select input_usd_per_mtok || '/' || output_usd_per_mtok from public.llm_route_models('intent_judge') where model_key = 'gemini.3-8-flash'),
     '0.750000/3.750000'),
  ('registry', 'Gemini 3.8 Flash price doubles on 2027-01-01 (effective-dated rows)',
     (select input_usd_per_mtok || '/' || output_usd_per_mtok from public.llm_route_models('intent_judge', date '2027-01-01') where model_key = 'gemini.3-8-flash'),
     '1.500000/7.500000'),
  ('registry', 'before the first price row nothing is routable (no price = never called)',
     (select count(*)::text from public.llm_route_models('facet_generation', date '2025-12-31')), '0'),
  ('registry', 'Haiku 5.5 carries its long-prompt tier (threshold/long input)',
     (select long_context_threshold || '/' || long_input_usd_per_mtok from public.llm_route_models('facet_generation') where model_key = 'anthropic.haiku-5-5'),
     '100000/0.500000'),
  ('registry', 'every seeded route points only at known models (all 12 tasks resolve to >= 1 model)',
     (select count(*)::text from public.llm_routes r where exists (select 1 from public.llm_route_models(r.task))), '12');

-- a disabled model drops out of its routes
update public.model_registry set enabled = false where key = 'anthropic.haiku-5-5';
insert into t_results (who, test, actual, expected) values
  ('registry', 'disabled model is skipped (cheap route starts at flash-lite)',
     (select string_agg(model_key, ',' order by pos) from public.llm_route_models('facet_generation')),
     'gemini.3-5-flash-lite,openai.gpt-6-luna');
update public.model_registry set enabled = true where key = 'anthropic.haiku-5-5';

-- a model with no price row is never routable; routes with unknown keys are rejected
insert into public.model_registry (key, provider, model_id, display_name) values ('test.noprice', 'openai', 'noprice-test', 'No price');
insert into public.llm_routes (task, model_keys) values ('zz_test_route', array['test.noprice', 'anthropic.sonnet-5-5']);
insert into t_results (who, test, actual, expected) values
  ('registry', 'a model without a price row is skipped',
     (select string_agg(model_key, ',' order by pos) from public.llm_route_models('zz_test_route')), 'anthropic.sonnet-5-5'),
  ('registry', 'route with an unknown model key is rejected',
     pg_temp.try($q$insert into public.llm_routes (task, model_keys) values ('zz_bad_route', array['nope.model'])$q$), 'err:23503'),
  ('registry', 'price row with a half-filled long tier is rejected',
     pg_temp.try($q$insert into public.model_prices (model_key, effective_from, input_usd_per_mtok, output_usd_per_mtok, long_context_threshold, source, checked_on)
                    values ('anthropic.sonnet-5-5', '2030-01-01', 1, 1, 1000, 'x', '2026-10-14')$q$), 'err:23514'),
  ('registry', 'unknown provider rejected', pg_temp.try($q$insert into public.model_registry (key, provider, model_id, display_name) values ('test.bad', 'acme', 'x', 'x')$q$), 'err:23514'),
  ('registry', 'credit_rates has the test_job action (1 credit)',
     (select credits::text from public.credit_rates where action = 'test_job'), '1'),
  ('registry', 'Unsplash flag exists and is OFF (CLAUDE.md)',
     (select enabled::text from public.feature_flags where key = 'unsplash_provider'), 'false');

-- ===========================================================================
-- 0005  BUDGET GUARD + COST LOG
-- ===========================================================================
create temp table t_base as select spent_today_usd as spent from public.llm_budget_check();

insert into t_results (who, test, actual, expected) values
  ('budget', 'default: allowed (guard and kill switch are OFF)',
     (select allowed::text || '/' || coalesce(reason, '-') from public.llm_budget_check()), 'true/-');

update public.feature_flags set enabled = true where key = 'llm_kill_switch';
insert into t_results (who, test, actual, expected) values
  ('budget', 'kill switch ON refuses everything',
     (select allowed::text || '/' || coalesce(reason, '-') from public.llm_budget_check()), 'false/kill_switch');
update public.feature_flags set enabled = false where key = 'llm_kill_switch';

insert into public.llm_calls (workspace_id, task, provider, model_key, model_id, status, input_tokens, output_tokens, cost_usd, latency_ms)
values (pg_temp.wsa(), 'test_echo', 'anthropic', 'test.model', 'test-model', 'ok', 100, 20, 6.000000, 400);
update public.feature_flags
  set enabled = true, rules = jsonb_build_object('daily_usd', (select spent from t_base) + 10)
  where key = 'llm_budget_guard';
insert into t_results (who, test, actual, expected) values
  ('budget', 'guard ON, spent 6 of 10 over baseline: still allowed',
     (select allowed::text from public.llm_budget_check()), 'true');
insert into public.llm_calls (workspace_id, task, provider, model_key, model_id, status, error_code, http_status, cost_usd, latency_ms)
values (pg_temp.wsa(), 'test_echo', 'anthropic', 'test.model', 'test-model', 'error', 'rate_limited', 429, 5.000000, 100);
insert into t_results (who, test, actual, expected) values
  ('budget', 'guard ON, spent 11 of 10 over baseline: blocked (daily_budget)',
     (select allowed::text || '/' || reason from public.llm_budget_check()), 'false/daily_budget'),
  ('budget', 'usage summary: 2 calls, 1 error, cost 11 for the test model',
     (select calls || '/' || errors || '/' || cost_usd from public.admin_llm_usage(24) where model_key = 'test.model'), '2/1/11.000000'),
  ('budget', 'purge_old_llm_calls(10) refused (min 30 days)', pg_temp.try($q$select public.purge_old_llm_calls(10)$q$), 'err:22023'),
  ('budget', 'llm_calls rejects an unknown status', pg_temp.try($q$insert into public.llm_calls (workspace_id, task, provider, model_key, model_id, status) values (pg_temp.wsa(), 't', 'p', 'k', 'm', 'weird')$q$), 'err:23514');
update public.feature_flags f set enabled = o.enabled, rules = o.rules from t_orig o where f.key = o.key;
insert into t_results (who, test, actual, expected) values
  ('budget', 'flags restored to their original values',
     (select string_agg(key || '=' || enabled::text, ',' order by key) from public.feature_flags where key in ('llm_kill_switch', 'llm_budget_guard')),
     (select string_agg(key || '=' || enabled::text, ',' order by key) from t_orig));

-- ===========================================================================
-- 0006  ENQUEUE (+ credit hold)
-- ===========================================================================
insert into t_ids select 'e1', public.job_enqueue(pg_temp.wsa(), 'test.llm_echo', '{"prompt":"x"}', 'jt:e1', 'test_job');
insert into t_results (who, test, actual, expected) values
  ('enqueue', 'job created queued with 1 credit held in the ledger',
     pg_temp.js(pg_temp.j('e1')) || '/' || pg_temp.hold(pg_temp.j('e1')) || '/' || pg_temp.bal(pg_temp.wsa()), 'queued/0/held/29/1'),
  ('enqueue', 'the hold references the job (ref_type job, ref_id = job id)',
     (select l.ref_type || '/' || (l.ref_id = j.id::text)::text from public.jobs j join public.credit_ledger l on l.id = j.credit_ledger_id where j.id = pg_temp.j('e1')), 'job/true'),
  ('enqueue', 'same key again: same job id, still ONE job and ONE hold',
     (public.job_enqueue(pg_temp.wsa(), 'test.llm_echo', '{"prompt":"x"}', 'jt:e1', 'test_job') = pg_temp.j('e1'))::text || '/' ||
     (select count(*) from public.jobs where idempotency_key = 'jt:e1') || '/' || pg_temp.bal(pg_temp.wsa()), 'true/1/29/1'),
  ('enqueue', 'same key, other type -> PM002',
     pg_temp.try($q$select public.job_enqueue(pg_temp.wsa(), 'test.noop', '{}', 'jt:e1')$q$), 'err:PM002'),
  ('enqueue', 'same key, other workspace -> PM002',
     pg_temp.try($q$select public.job_enqueue(pg_temp.wsb(), 'test.llm_echo', '{}', 'jt:e1', 'test_job')$q$), 'err:PM002'),
  ('enqueue', 'unknown credit action -> 22023 and no job row',
     pg_temp.try($q$select public.job_enqueue(pg_temp.wsa(), 'test.noop', '{}', 'jt:bad-action', 'no_such_action')$q$) || '/' ||
     (select count(*) from public.jobs where idempotency_key = 'jt:bad-action'), 'err:22023/0'),
  ('enqueue', 'max_attempts 0 -> 22023', pg_temp.try($q$select public.job_enqueue(pg_temp.wsa(), 'test.noop', '{}', 'jt:ma', null, now(), 0)$q$), 'err:22023'),
  ('enqueue', 'empty key -> 22023', pg_temp.try($q$select public.job_enqueue(pg_temp.wsa(), 'test.noop', '{}', '')$q$), 'err:22023'),
  ('enqueue', 'bad type name rejected by the table check', pg_temp.try($q$select public.job_enqueue(pg_temp.wsa(), 'Bad Type!', '{}', 'jt:badtype')$q$), 'err:23514');

insert into t_ids select 'free', public.job_enqueue(pg_temp.wsa(), 'test.noop', '{}', 'jt:free');
insert into t_results (who, test, actual, expected)
select 'enqueue', 'job without a credit action holds nothing',
       credit_amount || '/' || coalesce(credit_ledger_id::text, 'none'), '0/none'
from public.jobs where id = (select v from t_ids where k = 'free');

-- insufficient credits: no job row, nothing held (C drained first, restored after)
select public.credit_adjust(pg_temp.wsc(), -30, 'drain for test', 'jt:drain-c');
insert into t_results (who, test, actual, expected) values
  ('enqueue', 'balance 0: enqueue with a credit action fails PM001, NO job row, no hold',
     pg_temp.try($q$select public.job_enqueue(pg_temp.wsc(), 'test.llm_echo', '{}', 'jt:broke', 'test_job')$q$) || '/' ||
     (select count(*) from public.jobs where idempotency_key = 'jt:broke') || '/' || pg_temp.bal(pg_temp.wsc()), 'err:PM001/0/0/0');
select public.credit_adjust(pg_temp.wsc(), 30, 'restore after test', 'jt:restore-c');

-- ===========================================================================
-- 0006  CLAIM
-- ===========================================================================
-- clean slate for ordering tests: park e1 far in the future
update public.jobs set run_at = now() + interval '1 day' where workspace_id = pg_temp.wsa() and state = 'queued';
insert into t_ids select 'lo',  public.job_enqueue(pg_temp.wsa(), 'test.noop', '{}', 'jt:lo',  null, now() - interval '2 minutes', 3, 0);
insert into t_ids select 'hi',  public.job_enqueue(pg_temp.wsa(), 'test.noop', '{}', 'jt:hi',  null, now() - interval '1 minute',  3, 10);
insert into t_ids select 'fut', public.job_enqueue(pg_temp.wsa(), 'test.noop', '{}', 'jt:fut', null, now() + interval '1 hour',   3, 99);

create temp table t_claim1 as select * from public.job_claim('w-test-1', 1, 60);
insert into t_results (who, test, actual, expected) values
  ('claim', 'claim(1) returns the highest-priority due job, not the future one',
     (select count(*) || '/' || (min(id::text) = pg_temp.j('hi')::text)::text from t_claim1), '1/true'),
  ('claim', 'claimed job is running, attempts 1, owned by the worker, lease set',
     (select state || '/' || attempts || '/' || locked_by || '/' || (lease_expires_at > now())::text from public.jobs where id = pg_temp.j('hi')), 'running/1/w-test-1/true'),
  ('claim', 'future job (run_at in 1h) is not claimable',
     pg_temp.js(pg_temp.j('fut')), 'queued/0');

create temp table t_claim2 as select * from public.job_claim('w-test-2', 10, 60);
insert into t_results (who, test, actual, expected) values
  ('claim', 'a second claim never returns the running job and picks up the low-priority one',
     (select count(*) || '/' || (min(id::text) = pg_temp.j('lo')::text)::text from t_claim2), '1/true'),
  ('claim', 'claim argument validation (limit 0 / lease 1s / blank worker)',
     pg_temp.try($q$select * from public.job_claim('w', 0)$q$) || '/' || pg_temp.try($q$select * from public.job_claim('w', 1, 1)$q$) || '/' ||
     pg_temp.try($q$select * from public.job_claim('', 1)$q$), 'err:22023/err:22023/err:22023');

-- heartbeat
create temp table t_lease as select lease_expires_at as l from public.jobs where id = pg_temp.j('hi');
insert into t_results (who, test, actual, expected) values
  ('heartbeat', 'owner extends the lease',
     public.job_heartbeat(pg_temp.j('hi'), 'w-test-1', 600)::text || '/' ||
     (pg_temp.lease(pg_temp.j('hi')) > (select l from t_lease))::text, 'true/true'),
  ('heartbeat', 'another worker cannot extend it',
     public.job_heartbeat(pg_temp.j('hi'), 'w-test-2', 600)::text, 'false');

-- ===========================================================================
-- 0006  COMPLETE / FAIL (credit commit & release)
-- ===========================================================================
-- fresh credit-bearing job for the happy path
update public.jobs set state = 'canceled', finished_at = now() where id = pg_temp.j('e1');   -- (hold of e1 stays; released in cancel test below via other job)
select public.credit_release(credit_ledger_id) from public.jobs where id = pg_temp.j('e1');
insert into t_ids select 'c1', public.job_enqueue(pg_temp.wsa(), 'test.llm_echo', '{}', 'jt:c1', 'test_job');
create temp table t_claim3 as select * from public.job_claim('w-c1', 1, 60);   -- c1 is the only due job left with priority 0 and oldest? (lo is running) -> must be c1
insert into t_results (who, test, actual, expected) values
  ('complete', 'c1 was claimed (credit-bearing job)', (select (min(id::text) = pg_temp.j('c1')::text)::text from t_claim3), 'true'),
  ('complete', 'wrong worker cannot complete -> PM003',
     pg_temp.try($q$select public.job_complete(pg_temp.j('c1'), 'someone-else', '{}')$q$), 'err:PM003'),
  ('complete', 'after a refused completion the hold is still held',
     pg_temp.hold(pg_temp.j('c1')) || '/' || pg_temp.bal(pg_temp.wsa()), 'held/29/1'),
  ('complete', 'owner completes: succeeded, hold committed, balance 29/0',
     public.job_complete(pg_temp.j('c1'), 'w-c1', '{"ok":true}') || '/' || pg_temp.hold(pg_temp.j('c1')) || '/' || pg_temp.bal(pg_temp.wsa()), 'succeeded/committed/29/0'),
  ('complete', 'completing twice is a no-op (no double charge)',
     public.job_complete(pg_temp.j('c1'), 'w-c1', '{"ok":true}') || '/' || pg_temp.bal(pg_temp.wsa()) || '/' ||
     (select count(*) from public.credit_ledger where ref_type = 'job' and ref_id = pg_temp.j('c1')::text), 'succeeded/29/0/1'),
  ('complete', 'unknown job -> PM004', pg_temp.try($q$select public.job_complete(gen_random_uuid(), 'w', '{}')$q$), 'err:PM004'),
  ('complete', 'fail() after success is refused -> PM003',
     pg_temp.try($q$select public.job_fail(pg_temp.j('c1'), 'w-c1', 'late')$q$), 'err:PM003');
insert into t_results (who, test, actual, expected)
select 'complete', 'result stored, lease cleared', result::text || '/' || coalesce(locked_by, 'none'), '{"ok": true}/none'
from public.jobs where id = pg_temp.j('c1');

-- retry then dead letter: max_attempts 2, credit-bearing
insert into t_ids select 'f1', public.job_enqueue(pg_temp.wsa(), 'test.llm_echo', '{}', 'jt:f1', 'test_job', now(), 2);
create temp table t_claim4 as select * from public.job_claim('w-f1', 1, 60);
insert into t_results (who, test, actual, expected) values
  ('fail', 'f1 claimed (attempt 1 of 2), hold in place', (select (min(id::text) = pg_temp.j('f1')::text)::text from t_claim4) || '/' || pg_temp.bal(pg_temp.wsa()), 'true/28/1'),
  ('fail', 'retryable failure with attempts left -> queued, hold KEPT',
     public.job_fail(pg_temp.j('f1'), 'w-f1', 'provider overloaded', 'overloaded', true, 0) || '/' || pg_temp.js(pg_temp.j('f1')) || '/' || pg_temp.hold(pg_temp.j('f1')), 'queued/queued/1/held');
insert into t_results (who, test, actual, expected)
select 'fail', 'error text and code recorded', last_error || '/' || last_error_code, 'provider overloaded/overloaded'
from public.jobs where id = pg_temp.j('f1');
create temp table t_claim5 as select * from public.job_claim('w-f1b', 1, 60);
insert into t_results (who, test, actual, expected) values
  ('fail', 're-claimed as attempt 2', pg_temp.js(pg_temp.j('f1')), 'running/2'),
  ('fail', 'last attempt fails -> dead, hold RELEASED, balance back to 29/0',
     public.job_fail(pg_temp.j('f1'), 'w-f1b', repeat('x', 2000), 'overloaded', true, 0) || '/' || pg_temp.js(pg_temp.j('f1')) || '/' || pg_temp.hold(pg_temp.j('f1')) || '/' || pg_temp.bal(pg_temp.wsa()), 'dead/dead/2/released/29/0'),
  ('fail', 'stored error is truncated to 1000 chars (checked after the call above)',
     pg_temp.errlen(pg_temp.j('f1')), '1000');

-- non-retryable: dead immediately
insert into t_ids select 'f2', public.job_enqueue(pg_temp.wsa(), 'test.llm_echo', '{}', 'jt:f2', 'test_job');
create temp table t_claim6 as select * from public.job_claim('w-f2', 1, 60);
insert into t_results (who, test, actual, expected) values
  ('fail', 'non-retryable failure on attempt 1 of 3 -> dead at once, hold released',
     public.job_fail(pg_temp.j('f2'), 'w-f2', 'invalid payload', 'invalid_payload', false) || '/' || pg_temp.hold(pg_temp.j('f2')) || '/' || pg_temp.bal(pg_temp.wsa()), 'dead/released/29/0'),
  ('fail', 'default backoff for attempt 1 is 30-36 seconds (30s +0..20% jitter)',
     (select (public.job_backoff_seconds(1) between 30 and 36)::text), 'true'),
  ('fail', 'backoff grows and is capped at 1h + jitter',
     (select (public.job_backoff_seconds(3) between 120 and 144)::text || '/' || (public.job_backoff_seconds(20) between 3600 and 4320)::text), 'true/true');

-- ===========================================================================
-- 0006  WATCHDOG
-- ===========================================================================
insert into t_ids select 'w1', public.job_enqueue(pg_temp.wsa(), 'test.llm_echo', '{}', 'jt:w1', 'test_job', now(), 2);
insert into t_ids select 'w2', public.job_enqueue(pg_temp.wsa(), 'test.llm_echo', '{}', 'jt:w2', 'test_job', now(), 1);
-- park everything else so the claims below pick exactly w1 and w2
update public.jobs set run_at = now() + interval '1 day' where workspace_id = pg_temp.wsa() and state = 'queued' and id not in (pg_temp.j('w1'), pg_temp.j('w2'));
create temp table t_claim7 as select * from public.job_claim('w-dead-worker', 2, 60);
insert into t_results (who, test, actual, expected) values
  ('watchdog', 'two credit-bearing jobs running (balance 27/2)', (select count(*)::text from t_claim7) || '/' || pg_temp.bal(pg_temp.wsa()), '2/27/2'),
  ('watchdog', 'live leases are left alone', (select requeued || '/' || dead from public.job_watchdog()), '0/0');
update public.jobs set lease_expires_at = now() - interval '1 minute' where id in (pg_temp.j('w1'), pg_temp.j('w2'));
create temp table t_wd as select * from public.job_watchdog();
insert into t_results (who, test, actual, expected) values
  ('watchdog', 'expired lease: attempts left -> re-queued; exhausted -> dead (counts 1 and 1)',
     (select requeued || '/' || dead from t_wd), '1/1'),
  ('watchdog', 'w1 re-queued with lease_expired recorded, hold kept',
     pg_temp.js(pg_temp.j('w1')) || '/' || (select last_error_code from public.jobs where id = pg_temp.j('w1')) || '/' || pg_temp.hold(pg_temp.j('w1')), 'queued/1/lease_expired/held'),
  ('watchdog', 'w2 dead, hold released',
     pg_temp.js(pg_temp.j('w2')) || '/' || pg_temp.hold(pg_temp.j('w2')) || '/' || pg_temp.bal(pg_temp.wsa()), 'dead/1/released/28/1'),
  ('watchdog', 'the dead worker can no longer complete w1 (job not running)',
     pg_temp.try($q$select public.job_complete(pg_temp.j('w1'), 'w-dead-worker', '{}')$q$), 'err:PM003');

-- orphan holds: an old job-hold with no live job is released; one belonging to a live job is not
insert into public.credit_ledger (workspace_id, delta, reason, ref_type, ref_id, idempotency_key, status, created_at)
values (pg_temp.wsa(), -2, 'orphan', 'job', gen_random_uuid()::text, 'jt:orphan', 'held', now() - interval '30 hours');
update public.credit_ledger set created_at = created_at where false;   -- (no-op; ledger rows are immutable)
create temp table t_before_orphan as select pg_temp.bal(pg_temp.wsa()) as b;
create temp table t_wd2 as select * from public.job_watchdog(24);
insert into t_results (who, test, actual, expected) values
  ('watchdog', 'orphan job-hold older than 24h released (balance +2); the live job''s hold untouched',
     (select released_holds::text from t_wd2) || '/' || (select b from t_before_orphan) || '->' || pg_temp.bal(pg_temp.wsa()) || '/' || pg_temp.hold(pg_temp.j('w1')),
     '1/26/3->28/1/held');

-- ===========================================================================
-- 0006  CANCEL / RETRY (internal functions)
-- ===========================================================================
insert into t_results (who, test, actual, expected) values
  ('cancel', 'cancel a running job refused -> PM003',
     pg_temp.try($q$select public.job_cancel(pg_temp.j('hi'))$q$), 'err:PM003'),
  ('cancel', 'cancel a queued job: canceled + hold released (w1: 28/1 -> 29/0)',
     public.job_cancel(pg_temp.j('w1')) || '/' || pg_temp.js(pg_temp.j('w1')) || '/' || pg_temp.hold(pg_temp.j('w1')) || '/' || pg_temp.bal(pg_temp.wsa()), 'canceled/canceled/1/released/29/0'),
  ('cancel', 'cancel a dead job -> canceled (stays released)',
     public.job_cancel(pg_temp.j('f1')) || '/' || pg_temp.hold(pg_temp.j('f1')), 'canceled/released'),
  ('cancel', 'cancel twice -> PM003', pg_temp.try($q$select public.job_cancel(pg_temp.j('f1'))$q$), 'err:PM003');

-- retry a dead job: re-reserves credits
insert into t_results (who, test, actual, expected) values
  ('retry', 'retry a non-dead job refused -> PM003',
     pg_temp.try($q$select public.job_retry_dead(pg_temp.j('hi'))$q$), 'err:PM003'),
  ('retry', 'retry dead f2: queued, attempts reset, retry_count 1, NEW hold (balance 29/0 -> 28/1)',
     public.job_retry_dead(pg_temp.j('f2')) || '/' || pg_temp.js(pg_temp.j('f2')) || '/' || pg_temp.retries(pg_temp.j('f2')) || '/' || pg_temp.hold(pg_temp.j('f2')) || '/' || pg_temp.bal(pg_temp.wsa()), 'queued/queued/0/1/held/28/1'),
  ('retry', 'the old (released) hold row is kept: two ledger rows for the job (released + held)',
     pg_temp.ledger_states(pg_temp.j('f2')), 'held,released');

-- retry with insufficient credits
insert into t_ids select 'f3', public.job_enqueue(pg_temp.wsc(), 'test.llm_echo', '{}', 'jt:f3', 'test_job', now(), 1);
create temp table t_claim8 as select * from public.job_claim('w-f3', 1, 60) where false;   -- f3 stays queued; make it dead directly via claim below
update public.jobs set run_at = now() - interval '1 second' where id = pg_temp.j('f3');
update public.jobs set run_at = now() + interval '1 day' where state = 'queued' and id <> pg_temp.j('f3');
create temp table t_claim9 as select * from public.job_claim('w-f3', 1, 60);
select public.job_fail(pg_temp.j('f3'), 'w-f3', 'boom', 'boom', false);
select public.credit_adjust(pg_temp.wsc(), -29, 'drain for retry test', 'jt:drain-c2');   -- C: 30 - 1(held then released) -> 30, drain 29 leaves 1? see check
insert into t_results (who, test, actual, expected) values
  ('retry', 'C is at 1 credit after the drain', pg_temp.bal(pg_temp.wsc()), '1/0');
select public.credit_adjust(pg_temp.wsc(), -1, 'drain to zero', 'jt:drain-c3');
insert into t_results (who, test, actual, expected) values
  ('retry', 'retry dead job with balance 0 -> PM001, job stays dead, no new hold',
     pg_temp.try($q$select public.job_retry_dead(pg_temp.j('f3'))$q$) || '/' || pg_temp.js(pg_temp.j('f3')) || '/' || pg_temp.bal(pg_temp.wsc()), 'err:PM001/dead/1/0/0');
select public.credit_adjust(pg_temp.wsc(), 30, 'restore after tests', 'jt:restore-c2');

-- ===========================================================================
-- 0006  PROVIDER CONCURRENCY LIMITS
-- ===========================================================================
update public.jobs set state = 'canceled', finished_at = now(), credit_ledger_id = null where state = 'queued' and workspace_id in (pg_temp.wsa(), pg_temp.wsc());
insert into t_ids select 'p1', public.job_enqueue(pg_temp.wsa(), 'test.noop', '{}', 'jt:p1', null, now(), 3, 0, 'anthropic');
insert into t_ids select 'p2', public.job_enqueue(pg_temp.wsa(), 'test.noop', '{}', 'jt:p2', null, now(), 3, 0, 'anthropic');
insert into t_ids select 'p3', public.job_enqueue(pg_temp.wsa(), 'test.noop', '{}', 'jt:p3', null, now(), 3, 0, 'anthropic');
insert into t_ids select 'g1', public.job_enqueue(pg_temp.wsa(), 'test.noop', '{}', 'jt:g1', null, now(), 3, 0, 'gemini');
insert into t_ids select 'n1', public.job_enqueue(pg_temp.wsa(), 'test.noop', '{}', 'jt:n1', null, now(), 3, 0, null);
create temp table t_pl1 as select * from public.job_claim('w-pl', 10, 60, '{"anthropic": 2, "gemini": 0}');
insert into t_results (who, test, actual, expected) values
  ('concurrency', 'limits {anthropic:2, gemini:0}: claims 2 anthropic + the provider-less job, never gemini',
     (select count(*) filter (where provider = 'anthropic') || '/' || count(*) filter (where provider = 'gemini') || '/' || count(*) filter (where provider is null) from t_pl1), '2/0/1');
create temp table t_pl2 as select * from public.job_claim('w-pl2', 10, 60, '{"anthropic": 2}');
insert into t_results (who, test, actual, expected) values
  ('concurrency', 'while 2 anthropic jobs run, a further claim returns no anthropic job (the unlimited gemini one is fine)',
     (select count(*) filter (where provider = 'anthropic') || '/' || count(*) filter (where provider = 'gemini') from t_pl2), '0/1');
select public.job_complete(id, 'w-pl', '{}') from t_pl1 where provider = 'anthropic' limit 1;
create temp table t_pl3 as select * from public.job_claim('w-pl3', 10, 60, '{"anthropic": 2}');
insert into t_results (who, test, actual, expected) values
  ('concurrency', 'after one anthropic job finishes a slot frees up (the third anthropic job is claimed)',
     (select count(*)::text from t_pl3 where provider = 'anthropic'), '1');

-- ===========================================================================
-- 0006  ADMIN WRAPPERS (role check + audit, same transaction)
-- ===========================================================================
insert into t_ids select 'ad1', public.job_enqueue(pg_temp.wsa(), 'test.llm_echo', '{}', 'jt:ad1', 'test_job', now(), 1);
update public.jobs set run_at = now() + interval '1 day' where id <> pg_temp.j('ad1') and state = 'queued';
create temp table t_claim10 as select * from public.job_claim('w-ad1', 1, 60);
select public.job_fail(pg_temp.j('ad1'), 'w-ad1', 'boom', 'boom', false);
insert into t_ids select 'ad2', public.job_enqueue(pg_temp.wsa(), 'test.noop', '{}', 'jt:ad2', null, now() + interval '1 day');
create temp table t_adret as select public.admin_job_retry('c5c5c5c5-0000-0000-0000-000000000003', pg_temp.j('ad1'), '198.51.100.7') as r;

insert into t_results (who, test, actual, expected) values
  ('admin', 'user role cannot retry', pg_temp.try($q$select public.admin_job_retry('a5a5a5a5-0000-0000-0000-000000000001', pg_temp.j('ad1'))$q$), 'err:42501'),
  ('admin', 'user role cannot cancel', pg_temp.try($q$select public.admin_job_cancel('a5a5a5a5-0000-0000-0000-000000000001', pg_temp.j('ad2'))$q$), 'err:42501'),
  ('admin', 'user role cannot enqueue a test job', pg_temp.try($q$select public.admin_enqueue_test_job('a5a5a5a5-0000-0000-0000-000000000001', pg_temp.wsa(), 'k1')$q$), 'err:42501'),
  ('admin', 'support CAN retry a dead job; audit row written (job_retry, ip, before/after)',
     (select r from t_adret) || '/' ||
     pg_temp.audit_n('job_retry', pg_temp.j('ad1')) || '/' ||
     (select min(ip) || '/' || min(diff ->> 'state_before') || '/' || min(diff ->> 'state_after')
        from public.admin_audit where action = 'job_retry' and target_id = pg_temp.j('ad1')::text), 'queued/1/198.51.100.7/dead/queued'),
  ('admin', 'support CAN cancel a queued job; audit row written',
     public.admin_job_cancel('c5c5c5c5-0000-0000-0000-000000000003', pg_temp.j('ad2')) || '/' ||
     pg_temp.audit_n('job_cancel', pg_temp.j('ad2')), 'canceled/1'),
  ('admin', 'a refused retry (job not dead) writes NO audit row',
     pg_temp.try($q$select public.admin_job_retry('b5b5b5b5-0000-0000-0000-000000000002', pg_temp.j('ad2'))$q$) || '/' ||
     (select count(*) from public.admin_audit where action = 'job_retry' and target_id = pg_temp.j('ad2')::text), 'err:PM003/0'),
  ('admin', 'support cannot enqueue test jobs (superadmin only)', pg_temp.try($q$select public.admin_enqueue_test_job('c5c5c5c5-0000-0000-0000-000000000003', pg_temp.wsc(), 'k2')$q$), 'err:42501'),
  ('admin', 'superadmin cannot spend ANOTHER user''s credits via a test job',
     pg_temp.try($q$select public.admin_enqueue_test_job('b5b5b5b5-0000-0000-0000-000000000002', pg_temp.wsa(), 'k3')$q$), 'err:42501'),
  ('admin', 'invalid test mode -> 22023', pg_temp.try($q$select public.admin_enqueue_test_job('b5b5b5b5-0000-0000-0000-000000000002', pg_temp.wsb(), 'k4', 'nope')$q$), 'err:22023');

insert into t_ids select 'tj', public.admin_enqueue_test_job('b5b5b5b5-0000-0000-0000-000000000002', pg_temp.wsb(), 'k5', 'llm', '203.0.113.5');
insert into t_results (who, test, actual, expected) values
  ('admin', 'superadmin test job (llm): type test.llm_echo, 1 credit held on B''s own workspace',
     (select type from public.jobs where id = pg_temp.j('tj')) || '/' || pg_temp.hold(pg_temp.j('tj')) || '/' || pg_temp.bal(pg_temp.wsb()), 'test.llm_echo/held/29/1'),
  ('admin', 'replaying the same key: same job, still ONE audit row, still one hold',
     (public.admin_enqueue_test_job('b5b5b5b5-0000-0000-0000-000000000002', pg_temp.wsb(), 'k5', 'llm', '203.0.113.5') = pg_temp.j('tj'))::text || '/' ||
     (select count(*) from public.admin_audit where action = 'job_enqueue_test' and target_id = pg_temp.j('tj')::text) || '/' || pg_temp.bal(pg_temp.wsb()), 'true/1/29/1');
insert into t_ids select 'tn', public.admin_enqueue_test_job('b5b5b5b5-0000-0000-0000-000000000002', pg_temp.wsb(), 'k6', 'fail');
insert into t_ids select 'tp', public.admin_enqueue_test_job('b5b5b5b5-0000-0000-0000-000000000002', pg_temp.wsb(), 'k7', 'fail_permanent');
insert into t_results (who, test, actual, expected) values
  ('admin', 'noop test jobs cost nothing: modes fail / fail_permanent allow 2 / 1 attempts',
     (select j.type || '/' || j.credit_amount || '/' || j.max_attempts || '/' || (j.payload ->> 'mode') from public.jobs j where j.id = pg_temp.j('tn')) || '|' ||
     (select j.max_attempts || '/' || (j.payload ->> 'mode') from public.jobs j where j.id = pg_temp.j('tp')), 'test.noop/0/2/fail|1/fail_permanent'),
  ('admin', 'admin_job_counts lists states with counts (dead >= 1, canceled >= 1)',
     (select (coalesce(sum(jobs) filter (where state = 'dead'), 0) >= 1)::text || '/' || (coalesce(sum(jobs) filter (where state = 'canceled'), 0) >= 1)::text from public.admin_job_counts()), 'true/true');

-- ===========================================================================
-- 0006  RETENTION
-- ===========================================================================
insert into public.jobs (workspace_id, type, state, idempotency_key, finished_at, max_attempts)
values (pg_temp.wsa(), 'test.noop', 'succeeded', 'jt:old-ok', now() - interval '40 days', 1),
       (pg_temp.wsa(), 'test.noop', 'dead',      'jt:old-dead', now() - interval '40 days', 1);
create temp table t_purge as select public.purge_old_jobs(30) as n;
insert into t_results (who, test, actual, expected) values
  ('retention', 'purge_old_jobs(30) removes the old succeeded job, keeps the old dead-letter row',
     (select (n >= 1)::text from t_purge) || '/' || (select count(*) from public.jobs where idempotency_key = 'jt:old-ok') || '/' || (select count(*) from public.jobs where idempotency_key = 'jt:old-dead'), 'true/0/1'),
  ('retention', 'purge_old_jobs(3) refused (min 7 days)', pg_temp.try($q$select public.purge_old_jobs(3)$q$), 'err:22023');

-- ===========================================================================
-- PERMISSIONS as the real client roles
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"a5a5a5a5-0000-0000-0000-000000000001","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'a5a5a5a5-0000-0000-0000-000000000001', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('A', 'cannot read jobs', pg_temp.try($q$select count(*) from public.jobs$q$), 'err:42501'),
  ('A', 'cannot read llm_calls', pg_temp.try($q$select count(*) from public.llm_calls$q$), 'err:42501'),
  ('A', 'cannot read model_registry', pg_temp.try($q$select count(*) from public.model_registry$q$), 'err:42501'),
  ('A', 'cannot read model_prices', pg_temp.try($q$select count(*) from public.model_prices$q$), 'err:42501'),
  ('A', 'cannot read llm_routes', pg_temp.try($q$select count(*) from public.llm_routes$q$), 'err:42501'),
  ('A', 'cannot read credit_rates', pg_temp.try($q$select count(*) from public.credit_rates$q$), 'err:42501'),
  ('A', 'cannot read feature_flags', pg_temp.try($q$select count(*) from public.feature_flags$q$), 'err:42501'),
  ('A', 'cannot write jobs', pg_temp.try($q$insert into public.jobs (workspace_id, type, idempotency_key) values (pg_temp.wsa(), 'test.noop', 'client:i')$q$), 'err:42501'),
  ('A', 'cannot write credit_rates (price its own jobs at 0)', pg_temp.try($q$update public.credit_rates set credits = 0$q$), 'err:42501'),
  ('A', 'cannot flip the kill switch', pg_temp.try($q$update public.feature_flags set enabled = true$q$), 'err:42501'),
  ('A', 'cannot call job_enqueue', pg_temp.try($q$select public.job_enqueue(pg_temp.wsa(), 'test.noop', '{}', 'client:e')$q$), 'err:42501'),
  ('A', 'cannot call job_claim', pg_temp.try($q$select * from public.job_claim('w', 1)$q$), 'err:42501'),
  ('A', 'cannot call job_complete', pg_temp.try($q$select public.job_complete(gen_random_uuid(), 'w')$q$), 'err:42501'),
  ('A', 'cannot call job_fail', pg_temp.try($q$select public.job_fail(gen_random_uuid(), 'w', 'x')$q$), 'err:42501'),
  ('A', 'cannot call job_watchdog', pg_temp.try($q$select * from public.job_watchdog()$q$), 'err:42501'),
  ('A', 'cannot call job_cancel / job_retry_dead',
     pg_temp.try($q$select public.job_cancel(gen_random_uuid())$q$) || '/' || pg_temp.try($q$select public.job_retry_dead(gen_random_uuid())$q$), 'err:42501/err:42501'),
  ('A', 'cannot call admin_job_retry / admin_job_cancel / admin_enqueue_test_job',
     pg_temp.try($q$select public.admin_job_retry('a5a5a5a5-0000-0000-0000-000000000001', gen_random_uuid())$q$) || '/' ||
     pg_temp.try($q$select public.admin_job_cancel('a5a5a5a5-0000-0000-0000-000000000001', gen_random_uuid())$q$) || '/' ||
     pg_temp.try($q$select public.admin_enqueue_test_job('a5a5a5a5-0000-0000-0000-000000000001', pg_temp.wsa(), 'x')$q$), 'err:42501/err:42501/err:42501'),
  ('A', 'cannot call llm_route_models / llm_budget_check / admin_llm_usage / admin_job_counts',
     pg_temp.try($q$select * from public.llm_route_models('test_echo')$q$) || '/' || pg_temp.try($q$select * from public.llm_budget_check()$q$) || '/' ||
     pg_temp.try($q$select * from public.admin_llm_usage(24)$q$) || '/' || pg_temp.try($q$select * from public.admin_job_counts()$q$), 'err:42501/err:42501/err:42501/err:42501'),
  ('A', 'cannot call purge functions',
     pg_temp.try($q$select public.purge_old_jobs(30)$q$) || '/' || pg_temp.try($q$select public.purge_old_llm_calls(90)$q$), 'err:42501/err:42501');

reset role;
set role anon;
insert into t_results (who, test, actual, expected) values
  ('anon', 'cannot read jobs / llm_calls / model_registry / feature_flags',
     pg_temp.try($q$select count(*) from public.jobs$q$) || '/' || pg_temp.try($q$select count(*) from public.llm_calls$q$) || '/' ||
     pg_temp.try($q$select count(*) from public.model_registry$q$) || '/' || pg_temp.try($q$select count(*) from public.feature_flags$q$), 'err:42501/err:42501/err:42501/err:42501'),
  ('anon', 'cannot call job_enqueue / job_claim',
     pg_temp.try($q$select public.job_enqueue(pg_temp.wsa(), 'test.noop', '{}', 'anon:e')$q$) || '/' || pg_temp.try($q$select * from public.job_claim('w', 1)$q$), 'err:42501/err:42501');

reset role;
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('service_role', 'can enqueue, claim, complete (the job-runner path)',
     pg_temp.try($q$select public.job_complete((select id from public.job_claim('svc', 1) limit 1), 'svc', '{}')$q$ ), 'ok'),
  ('service_role', 'can resolve a route and check the budget',
     pg_temp.try($q$select * from public.llm_route_models('test_echo')$q$) || '/' || pg_temp.try($q$select * from public.llm_budget_check()$q$), 'ok/ok'),
  ('service_role', 'can run the watchdog and the purges',
     pg_temp.try($q$select * from public.job_watchdog()$q$) || '/' || pg_temp.try($q$select public.purge_old_jobs(30)$q$) || '/' || pg_temp.try($q$select public.purge_old_llm_calls(90)$q$), 'ok/ok/ok');

-- ---------------------------------------------------------------------------
-- Cleanup (audit rows are append-only: lift the guard for the test rows only) + cascade check
-- ---------------------------------------------------------------------------
reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where target_id in (select id::text from public.jobs where workspace_id in (select ws from t_ws));
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from public.llm_routes where task in ('zz_test_route', 'zz_bad_route');
delete from public.model_registry where key = 'test.noprice';

delete from auth.users where id in (
  'a5a5a5a5-0000-0000-0000-000000000001',
  'b5b5b5b5-0000-0000-0000-000000000002',
  'c5c5c5c5-0000-0000-0000-000000000003');

insert into t_results (who, test, actual, expected)
select 'cleanup', 'users, workspaces, jobs, ledger rows and llm_calls removed by cascade; test route/model gone',
       (select count(*) from public.workspaces where id in (select ws from t_ws)) || '/' ||
       (select count(*) from public.jobs where workspace_id in (select ws from t_ws)) || '/' ||
       (select count(*) from public.credit_ledger where workspace_id in (select ws from t_ws)) || '/' ||
       (select count(*) from public.llm_calls where workspace_id in (select ws from t_ws)) || '/' ||
       (select count(*) from public.llm_routes where task like 'zz_%') || '/' ||
       (select count(*) from public.model_registry where key = 'test.noprice'), '0/0/0/0/0/0';

select who, test, actual, expected, pass
from (
  select n as k, who, test, coalesce(actual, '<NULL>') as actual, expected, coalesce(actual = expected, false) as pass from t_results
  union all
  select 1000000, 'ALL CHECKS',
         (count(*) filter (where coalesce(actual = expected, false)))::text || ' of ' || count(*)::text || ' passed',
         '', '', bool_and(coalesce(actual = expected, false))
  from t_results
) s
order by k;
