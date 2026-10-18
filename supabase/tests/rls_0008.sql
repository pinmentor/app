-- rls_0008.sql — tests for migration 0008 (topical-map tables, run lifecycle with credit hold, embedding registry)
--
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0008 is applied). Safe to re-run.
-- It creates 4 throw-away users (A = member, B = other member, C = superadmin, D = support) with their own
-- workspaces and removes everything it created at the end.
--
-- EXPECTED OUTPUT: every row pass = true; last row  ALL CHECKS | <N> of <N> passed | (blank) | (blank) | true

reset role;

alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in (
  'a8a8a8a8-0000-0000-0000-000000000001','b8b8b8b8-0000-0000-0000-000000000002','c8c8c8c8-0000-0000-0000-000000000003','d8d8d8d8-0000-0000-0000-000000000004');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in (
  'a8a8a8a8-0000-0000-0000-000000000001','b8b8b8b8-0000-0000-0000-000000000002','c8c8c8c8-0000-0000-0000-000000000003','d8d8d8d8-0000-0000-0000-000000000004');

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;

create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('a8a8a8a8-0000-0000-0000-000000000001','authenticated','authenticated','a8@example.test', now()),
  ('b8b8b8b8-0000-0000-0000-000000000002','authenticated','authenticated','b8@example.test', now()),
  ('c8c8c8c8-0000-0000-0000-000000000003','authenticated','authenticated','c8@example.test', now()),
  ('d8d8d8d8-0000-0000-0000-000000000004','authenticated','authenticated','d8@example.test', now());
update public.profiles set role = 'superadmin' where user_id = 'c8c8c8c8-0000-0000-0000-000000000003';
update public.profiles set role = 'support'    where user_id = 'd8d8d8d8-0000-0000-0000-000000000004';

create temp table t_ws as select owner_id as uid, id as ws from public.workspaces
  where owner_id in ('a8a8a8a8-0000-0000-0000-000000000001','b8b8b8b8-0000-0000-0000-000000000002','c8c8c8c8-0000-0000-0000-000000000003','d8d8d8d8-0000-0000-0000-000000000004');
grant select on t_ws to anon, authenticated, service_role;
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to anon, authenticated, service_role;

create function pg_temp.wsa() returns uuid language sql as $$ select ws from t_ws where uid = 'a8a8a8a8-0000-0000-0000-000000000001' $$;
create function pg_temp.wsb() returns uuid language sql as $$ select ws from t_ws where uid = 'b8b8b8b8-0000-0000-0000-000000000002' $$;
create function pg_temp.wsc() returns uuid language sql as $$ select ws from t_ws where uid = 'c8c8c8c8-0000-0000-0000-000000000003' $$;
create function pg_temp.j(k text) returns uuid language sql as $$ select v from t_ids where k = $1 $$;
create function pg_temp.bal(w uuid) returns text language sql as $$ select available || '/' || held from public.credit_balance(w) $$;
create function pg_temp.run_state(id uuid) returns text language sql as $$ select status || '/' || stage from public.map_runs where map_runs.id = $1 $$;
create function pg_temp.hold(id uuid) returns text language sql as $$
  select l.status from public.map_runs r join public.credit_ledger l on l.id = r.credit_ledger_id where r.id = $1 $$;
grant execute on function pg_temp.wsa(), pg_temp.wsb(), pg_temp.wsc(), pg_temp.j(text), pg_temp.bal(uuid), pg_temp.run_state(uuid), pg_temp.hold(uuid)
  to anon, authenticated, service_role;

-- ===========================================================================
-- Pure pieces
-- ===========================================================================
insert into t_results (who, test, actual, expected) values
  ('cost', 'map_credit_cost = 10 + 5*ceil(n/25): 1, 25, 26, 100, 500',
     (select string_agg(public.map_credit_cost(n)::text, ',' order by n) from unnest(array[1,25,26,100,500]) n), '15,15,20,30,110'),
  ('registry', 'embedding route resolves to the OpenAI model only (Gemini embedding is disabled: no verified price)',
     (select string_agg(model_key, ',' order by pos) from public.llm_route_models('embedding')), 'openai.text-embedding-3-small'),
  ('registry', 'embedding price + dimensions come from the registry (0.02 per Mtok, 1536 dims)',
     (select p.input_usd_per_mtok || '/' || m.dimensions from public.model_registry m join public.llm_route_models('embedding') p on p.model_key = m.key where m.kind = 'embedding'),
     '0.020000/1536'),
  ('registry', 'chat models keep kind = chat',
     (select count(*)::text from public.model_registry where kind = 'chat' and key like 'anthropic.%'), '3');

-- ===========================================================================
-- Seed through the real server functions (as service_role)
-- ===========================================================================
set role service_role;
insert into t_ids values ('runA', public.map_run_create(pg_temp.wsa(), 'a8a8a8a8-0000-0000-0000-000000000001', 'peinados', 'es', 'es-MX', 20, 50, 'fast', 'k-a-1'));
insert into t_ids values ('runA2', public.map_run_create(pg_temp.wsa(), 'a8a8a8a8-0000-0000-0000-000000000001', 'peinados', 'es', 'es-MX', 20, 50, 'fast', 'k-a-1'));
insert into t_ids values ('runB', public.map_run_create(pg_temp.wsb(), 'b8b8b8b8-0000-0000-0000-000000000002', 'recetas', 'es', 'es-MX', 20, 25, 'economy', 'k-b-1'));
reset role;

insert into public.facets (workspace_id, map_run_id, name, kind) values (pg_temp.wsa(), pg_temp.j('runA'), 'occasion', 'occasion') returning id \gset fa_
insert into public.facets (workspace_id, map_run_id, name, kind) values (pg_temp.wsb(), pg_temp.j('runB'), 'occasion', 'occasion') returning id \gset fb_
insert into t_ids values ('facA', :'fa_id'), ('facB', :'fb_id');

insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, facet_id) values
  (pg_temp.wsa(), pg_temp.j('runA'), 'peinados fáciles', 'peinados fáciles', 'es', 'facet', pg_temp.j('facA')),
  (pg_temp.wsa(), pg_temp.j('runA'), 'peinados sencillos', 'peinados sencillos', 'es', 'facet', pg_temp.j('facA')),
  (pg_temp.wsb(), pg_temp.j('runB'), 'recetas fáciles', 'recetas fáciles', 'es', 'facet', pg_temp.j('facB'));
insert into t_ids select 'candA1', id from public.kw_candidates where raw = 'peinados fáciles';
insert into t_ids select 'candA2', id from public.kw_candidates where raw = 'peinados sencillos';
insert into t_ids select 'candB1', id from public.kw_candidates where raw = 'recetas fáciles';
insert into public.kw_pairs (map_run_id, workspace_id, a, b, cosine, verdict, judged_by, reason)
  select pg_temp.j('runA'), pg_temp.wsa(), least(pg_temp.j('candA1'), pg_temp.j('candA2')), greatest(pg_temp.j('candA1'), pg_temp.j('candA2')), 0.9, 'same', 'rule', 'synonym';
insert into public.golden_pairs (language, a, b, label, labeled_by) values ('es', 'zz test a', 'zz test b', 'same', 'test');

-- ===========================================================================
-- Creating a run: credits, idempotency, job, validation
-- ===========================================================================
insert into t_results (who, test, actual, expected) values
  ('create', 'run is queued at stage s1 and the hold is for map_credit_cost(50) = 20',
     pg_temp.run_state(pg_temp.j('runA')) || '/' || (select credit_amount from public.map_runs where id = pg_temp.j('runA')) || '/' || pg_temp.hold(pg_temp.j('runA')),
     'queued/s1_facets/20/held'),
  ('create', 'same idempotency key returns the same run and does not hold twice',
     (pg_temp.j('runA') = pg_temp.j('runA2'))::text || '/' || (select count(*) from public.map_runs where workspace_id = pg_temp.wsa())
       || '/' || (select count(*) from public.credit_ledger where ref_type = 'map_run' and ref_id = pg_temp.j('runA')::text),
     'true/1/1'),
  ('create', 'trial credits 30 - 20 held = 10 available, 20 held',
     pg_temp.bal(pg_temp.wsa()), '10/20'),
  ('create', 'S1 job was enqueued with the run id and NO credit of its own',
     (select count(*) || '/' || max(credit_amount) || '/' || bool_and(payload ->> 'mapRunId' = pg_temp.j('runA')::text)
        from public.jobs where type = 'map.s1_facets' and payload ->> 'mapRunId' = pg_temp.j('runA')::text),
     '1/0/true'),
  ('create', 'a project was created for the run',
     (select count(*)::text from public.projects p join public.map_runs r on r.project_id = p.id where r.id = pg_temp.j('runA') and p.workspace_id = pg_temp.wsa()), '1');

set role service_role;
insert into t_results (who, test, actual, expected) values
  ('create', 'non-member cannot create a run in someone else''s workspace',
     pg_temp.try($q$select public.map_run_create(pg_temp.wsb(), 'a8a8a8a8-0000-0000-0000-000000000001', 'x topic', 'es', 'es-MX', 20, 50, 'fast', 'k-bad-1')$q$), 'err:42501'),
  ('create', 'more credits than available -> PM001',
     pg_temp.try($q$select public.map_run_create(pg_temp.wsa(), 'a8a8a8a8-0000-0000-0000-000000000001', 'big topic', 'es', 'es-MX', 100, 1000, 'fast', 'k-big-1')$q$), 'err:PM001'),
  ('create', 'target_min > target_max -> 22023',
     pg_temp.try($q$select public.map_run_create(pg_temp.wsa(), 'a8a8a8a8-0000-0000-0000-000000000001', 'x topic', 'es', 'es-MX', 60, 50, 'fast', 'k-bad-2')$q$), 'err:22023'),
  ('create', 'target_max over 1000 -> 22023',
     pg_temp.try($q$select public.map_run_create(pg_temp.wsa(), 'a8a8a8a8-0000-0000-0000-000000000001', 'x topic', 'es', 'es-MX', 60, 5000, 'fast', 'k-bad-3')$q$), 'err:22023'),
  ('create', 'unknown mode -> 22023',
     pg_temp.try($q$select public.map_run_create(pg_temp.wsa(), 'a8a8a8a8-0000-0000-0000-000000000001', 'x topic', 'es', 'es-MX', 20, 50, 'warp', 'k-bad-4')$q$), 'err:22023'),
  ('create', 'a project id from another workspace is refused',
     pg_temp.try(format($q$select public.map_run_create(pg_temp.wsa(), 'a8a8a8a8-0000-0000-0000-000000000001', 'x topic', 'es', 'es-MX', 20, 50, 'fast', 'k-bad-5', %L)$q$,
       (select project_id from public.map_runs where id = pg_temp.j('runB')))), 'err:42501');
reset role;

insert into t_results (who, test, actual, expected) values
  ('create', 'every failed create left nothing behind (still 1 run, 1 project, balance 10/20 in A)',
     (select count(*) from public.map_runs where workspace_id = pg_temp.wsa()) || '/' || (select count(*) from public.projects where workspace_id = pg_temp.wsa()) || '/' || pg_temp.bal(pg_temp.wsa()),
     '1/1/10/20');

-- ===========================================================================
-- RLS as real client roles
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"a8a8a8a8-0000-0000-0000-000000000001","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'a8a8a8a8-0000-0000-0000-000000000001', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('A', 'sees own project, run, facet, candidates, pair',
     (select count(*) from public.projects) || '/' || (select count(*) from public.map_runs) || '/' || (select count(*) from public.facets) || '/' ||
     (select count(*) from public.kw_candidates) || '/' || (select count(*) from public.kw_pairs), '1/1/1/2/1'),
  ('A', 'does not see B''s rows',
     (select count(*) from public.map_runs where workspace_id = pg_temp.wsb()) || '/' || (select count(*) from public.kw_candidates where workspace_id = pg_temp.wsb()), '0/0'),
  ('A', 'cannot insert into any map table',
     pg_temp.try(format($q$insert into public.projects (workspace_id, name, topic, language, locale) values (%L, 'p', 'pp', 'es', 'es-MX')$q$, pg_temp.wsa())) || '/' ||
     pg_temp.try(format($q$insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source) values (%L, %L, 'x', 'x', 'es', 'manual')$q$, pg_temp.wsa(), pg_temp.j('runA'))) || '/' ||
     pg_temp.try(format($q$insert into public.facets (workspace_id, map_run_id, name) values (%L, %L, 'f')$q$, pg_temp.wsa(), pg_temp.j('runA'))),
     'err:42501/err:42501/err:42501'),
  ('A', 'cannot update or delete a run (cannot fake status or credits)',
     pg_temp.try($q$update public.map_runs set status = 'succeeded'$q$) || '/' || pg_temp.try($q$delete from public.map_runs$q$) || '/' ||
     pg_temp.try($q$update public.kw_candidates set status = 'primary'$q$) || '/' || pg_temp.try($q$delete from public.kw_pairs$q$),
     'err:42501/err:42501/err:42501/err:42501'),
  ('A', 'cannot read the global golden_pairs set', pg_temp.try($q$select count(*) from public.golden_pairs$q$), 'err:42501'),
  ('A', 'cannot call any map function',
     pg_temp.try(format($q$select public.map_run_create(%L, 'a8a8a8a8-0000-0000-0000-000000000001', 'x topic', 'es', 'es-MX', 20, 50, 'fast', 'k-c-1')$q$, pg_temp.wsa())) || '/' ||
     pg_temp.try(format($q$select public.map_run_finish(%L, 'succeeded')$q$, pg_temp.j('runA'))) || '/' ||
     pg_temp.try(format($q$select public.map_run_cancel(%L, 'a8a8a8a8-0000-0000-0000-000000000001')$q$, pg_temp.j('runA'))) || '/' ||
     pg_temp.try($q$select public.map_run_watchdog()$q$) || '/' ||
     pg_temp.try($q$select * from public.admin_map_run_list()$q$) || '/' ||
     pg_temp.try($q$select public.map_credit_cost(10)$q$),
     'err:42501/err:42501/err:42501/err:42501/err:42501/err:42501');
reset role;

select set_config('request.jwt.claims', '{}', false);
select set_config('request.jwt.claim.sub', '', false);
set role anon;
insert into t_results (who, test, actual, expected) values
  ('anon', 'cannot read any map table',
     pg_temp.try($q$select count(*) from public.map_runs$q$) || '/' || pg_temp.try($q$select count(*) from public.kw_candidates$q$) || '/' ||
     pg_temp.try($q$select count(*) from public.golden_pairs$q$), 'err:42501/err:42501/err:42501');
reset role;

-- ===========================================================================
-- Table constraints
-- ===========================================================================
insert into t_results (who, test, actual, expected) values
  ('constraint', 'the same keyword cannot be stored twice in a run (idempotent retries)',
     pg_temp.try(format($q$insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source) values (%L, %L, 'Peinados Fáciles ', 'peinados fáciles', 'es', 'facet')$q$, pg_temp.wsa(), pg_temp.j('runA'))), 'err:23505'),
  ('constraint', 'a pair must be stored with a < b (no mirrored duplicates)',
     pg_temp.try(format($q$insert into public.kw_pairs (map_run_id, workspace_id, a, b) values (%L, %L, greatest(%L::uuid, %L::uuid), least(%L::uuid, %L::uuid))$q$,
       pg_temp.j('runA'), pg_temp.wsa(), pg_temp.j('candA1'), pg_temp.j('candA2'), pg_temp.j('candA1'), pg_temp.j('candA2'))), 'err:23514'),
  ('constraint', 'bad candidate status / pair verdict rejected',
     pg_temp.try(format($q$update public.kw_candidates set status = 'weird' where id = %L$q$, pg_temp.j('candA1'))) || '/' ||
     pg_temp.try(format($q$update public.kw_pairs set verdict = 'maybe' where map_run_id = %L$q$, pg_temp.j('runA'))), 'err:23514/err:23514');

-- ===========================================================================
-- Lifecycle: stage status, finish (commit / release), cancel, watchdog
-- ===========================================================================
insert into t_results (who, test, actual, expected) values
  ('stage', 'map_stage_status counts the run''s jobs of one type',
     (select queued || '/' || running || '/' || succeeded || '/' || dead from public.map_stage_status(pg_temp.j('runA'), 'map.s1_facets')), '1/0/0/0');

set role service_role;
select public.map_run_set_stage(pg_temp.j('runA'), 's2_expand');
reset role;
insert into t_results (who, test, actual, expected) values
  ('stage', 'set_stage moves a queued run to running', pg_temp.run_state(pg_temp.j('runA')), 'running/s2_expand');

-- success commits the hold
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('finish', 'succeeded returns succeeded', public.map_run_finish(pg_temp.j('runA'), 'succeeded', null, '{"primaries": 2}'::jsonb), 'succeeded'),
  ('finish', 'replay is a no-op that returns the final state', public.map_run_finish(pg_temp.j('runA'), 'failed', 'late failure'), 'succeeded');
reset role;
insert into t_results (who, test, actual, expected) values
  ('finish', 'credits are committed (spent), hold gone, stats saved, stage done',
     pg_temp.hold(pg_temp.j('runA')) || '/' || pg_temp.bal(pg_temp.wsa()) || '/' || pg_temp.run_state(pg_temp.j('runA')) || '/' || (select stats ->> 'primaries' from public.map_runs where id = pg_temp.j('runA')),
     'committed/10/0/succeeded/done/2');

-- top A up so the next runs can be created (trial credits are spent)
set role service_role;
select public.credit_adjust(pg_temp.wsa(), 100, 'test top-up', 'rls0008-topup-a');
insert into t_ids values ('runF', public.map_run_create(pg_temp.wsa(), 'a8a8a8a8-0000-0000-0000-000000000001', 'fallo', 'es', 'es-MX', 10, 25, 'fast', 'k-f-1'));
reset role;
insert into t_results (who, test, actual, expected) values
  ('finish', 'balance after top-up and a new 25-item run (cost 15): 110 - 15 = 95 available, 15 held',
     pg_temp.bal(pg_temp.wsa()), '95/15');

set role service_role;
insert into t_results (who, test, actual, expected) values
  ('finish', 'failed returns failed', public.map_run_finish(pg_temp.j('runF'), 'failed', repeat('x', 500)), 'failed');
reset role;
insert into t_results (who, test, actual, expected) values
  ('finish', 'failure RELEASES the hold (credits back), error text capped at 300 chars, queued stage job canceled',
     pg_temp.hold(pg_temp.j('runF')) || '/' || pg_temp.bal(pg_temp.wsa()) || '/' || (select char_length(last_error) from public.map_runs where id = pg_temp.j('runF')) || '/' ||
     (select state from public.jobs where type = 'map.s1_facets' and payload ->> 'mapRunId' = pg_temp.j('runF')::text),
     'released/110/0/300/canceled');

-- user cancel: only a member, and it releases
set role service_role;
insert into t_ids values ('runC', public.map_run_create(pg_temp.wsa(), 'a8a8a8a8-0000-0000-0000-000000000001', 'cancelar', 'es', 'es-MX', 10, 25, 'fast', 'k-c-2'));
insert into t_results (who, test, actual, expected) values
  ('cancel', 'a non-member cannot cancel',
     pg_temp.try(format($q$select public.map_run_cancel(%L, 'b8b8b8b8-0000-0000-0000-000000000002')$q$, pg_temp.j('runC'))), 'err:42501'),
  ('cancel', 'a member cancels: canceled', public.map_run_cancel(pg_temp.j('runC'), 'a8a8a8a8-0000-0000-0000-000000000001'), 'canceled'),
  ('cancel', 'unknown run -> PM004', pg_temp.try($q$select public.map_run_cancel(gen_random_uuid(), 'a8a8a8a8-0000-0000-0000-000000000001')$q$), 'err:PM004');
reset role;
insert into t_results (who, test, actual, expected) values
  ('cancel', 'cancel released the hold: balance back to 110/0', pg_temp.hold(pg_temp.j('runC')) || '/' || pg_temp.bal(pg_temp.wsa()), 'released/110/0');

-- watchdog: (1) a run whose stage job died, (2) an idle run with no live job, (3) a healthy run is left alone
set role service_role;
insert into t_ids values ('runD', public.map_run_create(pg_temp.wsa(), 'a8a8a8a8-0000-0000-0000-000000000001', 'muerto', 'es', 'es-MX', 10, 25, 'fast', 'k-d-1'));
insert into t_ids values ('runI', public.map_run_create(pg_temp.wsa(), 'a8a8a8a8-0000-0000-0000-000000000001', 'inactivo', 'es', 'es-MX', 10, 25, 'fast', 'k-i-1'));
insert into t_ids values ('runH', public.map_run_create(pg_temp.wsa(), 'a8a8a8a8-0000-0000-0000-000000000001', 'sano', 'es', 'es-MX', 10, 25, 'fast', 'k-h-1'));
reset role;
update public.jobs set state = 'dead', finished_at = now(), last_error_code = 'x'
  where type = 'map.s1_facets' and payload ->> 'mapRunId' = pg_temp.j('runD')::text;
update public.jobs set state = 'succeeded', finished_at = now()
  where type = 'map.s1_facets' and payload ->> 'mapRunId' = pg_temp.j('runI')::text;
alter table public.map_runs disable trigger map_runs_touch_trg;   -- else the touch trigger would reset updated_at
update public.map_runs set updated_at = now() - interval '30 minutes' where id in (pg_temp.j('runD'), pg_temp.j('runI'), pg_temp.j('runH'));
alter table public.map_runs enable trigger map_runs_touch_trg;
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('watchdog', 'two runs are failed (dead job; idle without a live job), the healthy one is not', public.map_run_watchdog()::text, '2');
reset role;
insert into t_results (who, test, actual, expected) values
  ('watchdog', 'states: dead job -> failed, idle -> failed, healthy -> still queued',
     (select status from public.map_runs where id = pg_temp.j('runD')) || '/' || (select status from public.map_runs where id = pg_temp.j('runI')) || '/' || (select status from public.map_runs where id = pg_temp.j('runH')),
     'failed/failed/queued'),
  ('watchdog', 'failed runs released their holds, the healthy one keeps its hold',
     pg_temp.hold(pg_temp.j('runD')) || '/' || pg_temp.hold(pg_temp.j('runI')) || '/' || pg_temp.hold(pg_temp.j('runH')), 'released/released/held');
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('watchdog', 'running it again changes nothing', public.map_run_watchdog()::text, '0');
reset role;

-- ===========================================================================
-- Stage helpers: kw_apply_updates, kw_pending_pairs, kw_cap_pending, map_run_cost_usd (on the healthy run runH)
-- ===========================================================================
insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source) values
  (pg_temp.wsa(), pg_temp.j('runH'), 'h1', 'h1', 'es', 'test'), (pg_temp.wsa(), pg_temp.j('runH'), 'h2', 'h2', 'es', 'test'),
  (pg_temp.wsa(), pg_temp.j('runH'), 'h3', 'h3', 'es', 'test'), (pg_temp.wsa(), pg_temp.j('runH'), 'h4', 'h4', 'es', 'test');
create function pg_temp.h(raw text) returns uuid language sql as $$
  select id from public.kw_candidates where kw_candidates.raw = $1 and map_run_id = (select v from t_ids where k = 'runH') $$;
grant execute on function pg_temp.h(text) to anon, authenticated, service_role;
insert into public.kw_pairs (map_run_id, workspace_id, a, b, cosine)
  select pg_temp.j('runH'), pg_temp.wsa(), least(pg_temp.h(x), pg_temp.h(y)), greatest(pg_temp.h(x), pg_temp.h(y)), c
  from (values ('h1','h2',0.90), ('h1','h3',0.80), ('h1','h4',0.70), ('h2','h3',0.65)) v(x, y, c);

set role service_role;
insert into t_results (who, test, actual, expected) values
  ('apply', 'kw_apply_updates updates the given fields on 3 rows of the run, leaves the rest',
     public.kw_apply_updates(pg_temp.j('runH'), jsonb_build_array(
       jsonb_build_object('id', pg_temp.h('h1'), 'norm_key', 'k1', 'seq', 0, 'status', 'raw'),
       jsonb_build_object('id', pg_temp.h('h2'), 'norm_key', 'k2', 'seq', 1),
       jsonb_build_object('id', pg_temp.h('h3'), 'status', 'merged', 'merged_into', pg_temp.h('h1'), 'merge_reason', 'same key')))::text, '3'),
  ('apply', 'a row of ANOTHER run is not touched by this run id',
     public.kw_apply_updates(pg_temp.j('runH'), jsonb_build_array(jsonb_build_object('id', pg_temp.j('candB1'), 'status', 'dropped')))::text, '0'),
  ('apply', 'non-array / oversize payload -> 22023', pg_temp.try($q$select public.kw_apply_updates(gen_random_uuid(), '{"a":1}'::jsonb)$q$), 'err:22023'),
  ('apply', 'an invalid status is rejected by the table check (whole call fails)',
     pg_temp.try(format($q$select public.kw_apply_updates(%L, jsonb_build_array(jsonb_build_object('id', %L, 'status', 'weird')))$q$, pg_temp.j('runH'), pg_temp.h('h4'))), 'err:23514');
reset role;
insert into t_results (who, test, actual, expected) values
  ('apply', 'result: h1 = raw/k1/0, h2 = raw/k2/1 (status default kept), h3 = merged into h1, h4 untouched, B''s candidate still raw',
     (select status || '/' || norm_key || '/' || seq from public.kw_candidates where id = pg_temp.h('h1')) || ';' ||
     (select status || '/' || norm_key || '/' || seq from public.kw_candidates where id = pg_temp.h('h2')) || ';' ||
     (select status || '/' || (merged_into = pg_temp.h('h1'))::text || '/' || merge_reason from public.kw_candidates where id = pg_temp.h('h3')) || ';' ||
     (select status || '/' || coalesce(norm_key, '-') from public.kw_candidates where id = pg_temp.h('h4')) || ';' ||
     (select status from public.kw_candidates where id = pg_temp.j('candB1')),
     'raw/k1/0;raw/k2/1;merged/true/same key;raw/-;raw');

set role service_role;
insert into t_results (who, test, actual, expected) values
  ('pending', 'one slot sees all 4 pending pairs, highest cosine first',
     (select count(*) || '/' || string_agg(round(cosine::numeric, 2)::text, ',' order by cosine desc) from public.kw_pending_pairs(pg_temp.j('runH'), 0, 1, 50)), '4/0.90,0.80,0.70,0.65'),
  ('pending', 'two slots split the pairs: disjoint and together all 4',
     (select count(*) || '/' || count(distinct (a, b)) from (
        select * from public.kw_pending_pairs(pg_temp.j('runH'), 0, 2, 50) union all select * from public.kw_pending_pairs(pg_temp.j('runH'), 1, 2, 50)) u), '4/4'),
  ('pending', 'limit applies', (select count(*)::text from public.kw_pending_pairs(pg_temp.j('runH'), 0, 1, 2)), '2'),
  ('pending', 'pair rows carry the keyword texts for the judge',
     (select count(*) filter (where a_raw like 'h_' and b_raw like 'h_')::text from public.kw_pending_pairs(pg_temp.j('runH'), 0, 1, 50)), '4'),
  ('cap', 'keeping the top 2 settles the other 2 as related/cap', public.kw_cap_pending(pg_temp.j('runH'), 2)::text, '2');
reset role;
insert into t_results (who, test, actual, expected) values
  ('cap', 'the two highest-cosine pairs are still pending; the lowest two are related by cap',
     (select string_agg(round(cosine::numeric, 2)::text, ',' order by cosine desc) from public.kw_pairs where map_run_id = pg_temp.j('runH') and verdict is null) || ';' ||
     (select string_agg(round(cosine::numeric, 2)::text || '/' || judged_by, ',' order by cosine desc) from public.kw_pairs where map_run_id = pg_temp.j('runH') and verdict = 'related'),
     '0.90,0.80;0.70/cap,0.65/cap');

insert into public.llm_calls (workspace_id, job_id, task, provider, model_key, model_id, status, cost_usd)
  select pg_temp.wsa(), j.id, 'facet_generation', 'anthropic', 'anthropic.haiku-5-5', 'claude-haiku-5-5', 'ok', 0.5
  from public.jobs j where j.type = 'map.s1_facets' and j.payload ->> 'mapRunId' = pg_temp.j('runH')::text;
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('cost', 'map_run_cost_usd sums the LLM calls of the run''s jobs (0.5), 0 for a run without calls',
     public.map_run_cost_usd(pg_temp.j('runH'))::text || '/' || public.map_run_cost_usd(pg_temp.j('runB'))::text, '0.500000/0');
reset role;
select set_config('request.jwt.claims', '{"sub":"a8a8a8a8-0000-0000-0000-000000000001","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'a8a8a8a8-0000-0000-0000-000000000001', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('A', 'cannot call the stage helpers',
     pg_temp.try($q$select public.kw_apply_updates(gen_random_uuid(), '[]'::jsonb)$q$) || '/' ||
     pg_temp.try($q$select * from public.kw_pending_pairs(gen_random_uuid(), 0, 1, 10)$q$) || '/' ||
     pg_temp.try($q$select public.kw_cap_pending(gen_random_uuid(), 1)$q$) || '/' ||
     pg_temp.try($q$select public.map_run_cost_usd(gen_random_uuid())$q$), 'err:42501/err:42501/err:42501/err:42501');
reset role;

-- ===========================================================================
-- Admin entry point
-- ===========================================================================
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('admin', 'support (not superadmin) cannot start a run',
     pg_temp.try($q$select public.admin_map_run_create('d8d8d8d8-0000-0000-0000-000000000004', (select ws from t_ws where uid = 'd8d8d8d8-0000-0000-0000-000000000004'), 'tema', 'es', 'es-MX', 10, 25, 'fast', 'adm-1')$q$), 'err:42501'),
  ('admin', 'superadmin cannot spend ANOTHER workspace''s credits',
     pg_temp.try(format($q$select public.admin_map_run_create('c8c8c8c8-0000-0000-0000-000000000003', %L, 'tema', 'es', 'es-MX', 10, 25, 'fast', 'adm-2')$q$, pg_temp.wsa())), 'err:42501');
insert into t_ids values ('runS', public.admin_map_run_create('c8c8c8c8-0000-0000-0000-000000000003', pg_temp.wsc(), 'tema', 'es', 'es-MX', 10, 25, 'fast', 'adm-3', '203.0.113.8'));
insert into t_ids values ('runS2', public.admin_map_run_create('c8c8c8c8-0000-0000-0000-000000000003', pg_temp.wsc(), 'tema', 'es', 'es-MX', 10, 25, 'fast', 'adm-3', '203.0.113.8'));
reset role;
insert into t_results (who, test, actual, expected) values
  ('admin', 'superadmin run created in own workspace, replay returns the same run',
     (pg_temp.j('runS') = pg_temp.j('runS2'))::text || '/' || pg_temp.run_state(pg_temp.j('runS')) || '/' || pg_temp.hold(pg_temp.j('runS')), 'true/queued/s1_facets/held'),
  ('admin', 'exactly one admin_audit row (with credits), none for refused calls or the replay',
     (select count(*) || '/' || max(diff ->> 'credits') from public.admin_audit where action = 'map_run_create' and target_id = pg_temp.j('runS')::text) || '/' ||
     (select count(*) from public.admin_audit where action = 'map_run_create' and admin_id in ('d8d8d8d8-0000-0000-0000-000000000004')),
     '1/15/0'),
  ('admin', 'admin_map_run_list shows the runs with live counters',
     (select count(*) filter (where id = pg_temp.j('runA') and candidates = 2) || '/' || count(*) filter (where id = pg_temp.j('runA') and primaries = 0)
        from public.admin_map_run_list(100)), '1/1');

-- ===========================================================================
-- Cascade + cleanup
-- ===========================================================================
delete from public.map_runs where id = pg_temp.j('runA');
insert into t_results (who, test, actual, expected) values
  ('cascade', 'deleting a run removes its facets, candidates and pairs',
     (select count(*) from public.facets where id = pg_temp.j('facA')) || '/' || (select count(*) from public.kw_candidates where id in (pg_temp.j('candA1'), pg_temp.j('candA2'))) || '/' ||
     (select count(*) from public.kw_pairs where a = pg_temp.j('candA1')), '0/0/0');

delete from public.golden_pairs where labeled_by = 'test' and a = 'zz test a';
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in (
  'a8a8a8a8-0000-0000-0000-000000000001','b8b8b8b8-0000-0000-0000-000000000002','c8c8c8c8-0000-0000-0000-000000000003','d8d8d8d8-0000-0000-0000-000000000004');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from public.jobs where payload ->> 'mapRunId' in (select id::text from public.map_runs where workspace_id in (select ws from t_ws));
delete from auth.users where id in (
  'a8a8a8a8-0000-0000-0000-000000000001','b8b8b8b8-0000-0000-0000-000000000002','c8c8c8c8-0000-0000-0000-000000000003','d8d8d8d8-0000-0000-0000-000000000004');

insert into t_results (who, test, actual, expected)
select 'cleanup', 'test users, workspaces, runs, audit rows and golden test pair are gone',
       (select count(*) from auth.users where email like '%8@example.test') || '/' ||
       (select count(*) from public.map_runs where id in (select v from t_ids where k like 'run%')) || '/' ||
       (select count(*) from public.golden_pairs where a = 'zz test a'), '0/0/0';

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
