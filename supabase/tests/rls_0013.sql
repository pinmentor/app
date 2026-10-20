-- rls_0013.sql — tests for migration 0013 (approve / reject plan items: membership, report gate, idempotency)
--
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0008-0013 are applied). Safe to re-run.
-- Creates two throw-away users (A owns the run, B is a stranger) and removes everything at the end.
-- EXPECTED OUTPUT: every row pass = true; last row  ALL CHECKS | <N> of <N> passed | (blank) | (blank) | true

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a1310101-0000-0000-0000-000000000001','b1310101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a1310101-0000-0000-0000-000000000001','b1310101-0000-0000-0000-000000000002');

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('a1310101-0000-0000-0000-000000000001','authenticated','authenticated','a13@example.test', now()),
  ('b1310101-0000-0000-0000-000000000002','authenticated','authenticated','b13@example.test', now());
create temp table t_ws as select owner_id as uid, id as ws from public.workspaces
  where owner_id in ('a1310101-0000-0000-0000-000000000001','b1310101-0000-0000-0000-000000000002');
grant select on t_ws to anon, authenticated, service_role;
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to anon, authenticated, service_role;
create function pg_temp.wsa() returns uuid language sql as $$ select ws from t_ws where uid = 'a1310101-0000-0000-0000-000000000001' $$;
create function pg_temp.j(k text) returns uuid language sql as $$ select v from t_ids where k = $1 $$;
grant execute on function pg_temp.wsa(), pg_temp.j(text) to anon, authenticated, service_role;

-- run 'ok': flag report, finished; run 'red': fail report, finished; run 'live': still running (no report)
set role service_role;
select public.credit_adjust(pg_temp.wsa(), 100, 'test_grant', 'test-0013:' || pg_temp.wsa()::text, 'test', 'x');
insert into t_ids values ('ok',  public.map_run_create(pg_temp.wsa(), 'a1310101-0000-0000-0000-000000000001', 'peinados', 'es', 'es-MX', 20, 50, 'fast', 'k-a13-ok'));
insert into t_ids values ('red', public.map_run_create(pg_temp.wsa(), 'a1310101-0000-0000-0000-000000000001', 'recetas', 'es', 'es-MX', 20, 50, 'fast', 'k-a13-red'));
insert into t_ids values ('live', public.map_run_create(pg_temp.wsa(), 'a1310101-0000-0000-0000-000000000001', 'tatuajes', 'es', 'es-MX', 20, 50, 'fast', 'k-a13-live'));
reset role;

-- six items per run: i1..i4 clean, i5 and i6 flagged
insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, seq, status)
select pg_temp.wsa(), pg_temp.j(k), k || g, k || g, 'es', 'test', g, 'primary' from (values ('ok'), ('red'), ('live')) r(k), generate_series(1, 6) g;
insert into public.plan_items (workspace_id, project_id, map_run_id, primary_kw_id, keyword, article_type, position, flags)
select pg_temp.wsa(), (select project_id from public.map_runs where id = pg_temp.j(r.k)), pg_temp.j(r.k), c.id, c.raw, 'A', c.seq,
       case when c.seq >= 5 then array['mixed_intent'] else '{}'::text[] end
from (values ('ok'), ('red'), ('live')) r(k) join public.kw_candidates c on c.map_run_id = pg_temp.j(r.k);

set role service_role;
select public.map_run_set_report(pg_temp.j('ok'),  '{"verdict":"flag","checks":[]}'::jsonb);
select public.map_run_set_report(pg_temp.j('red'), '{"verdict":"fail","checks":[]}'::jsonb);
select public.map_run_finish(pg_temp.j('ok'), 'succeeded');
select public.map_run_finish(pg_temp.j('red'), 'succeeded');
reset role;

create function pg_temp.ids(run text, lo int, hi int) returns uuid[] language sql as $$
  select coalesce(array_agg(id order by position), '{}') from public.plan_items where map_run_id = pg_temp.j($1) and position between $2 and $3 $$;
grant execute on function pg_temp.ids(text, int, int) to anon, authenticated, service_role;
create function pg_temp.cnt(run text, st text) returns text language sql as $$
  select count(*)::text from public.plan_items where map_run_id = pg_temp.j($1) and status = $2 $$;
grant execute on function pg_temp.cnt(text, text) to anon, authenticated, service_role;

-- ===========================================================================
-- Approve / reject / back to draft
-- ===========================================================================
set role service_role;
create temp table t_calls (k text primary key, v text);
grant all on t_calls to anon, authenticated, service_role;
insert into t_calls values ('approve12', public.plan_items_set_status('a1310101-0000-0000-0000-000000000001', pg_temp.j('ok'), pg_temp.ids('ok', 1, 2), 'approved')::text);
insert into t_calls values ('approve12_again', public.plan_items_set_status('a1310101-0000-0000-0000-000000000001', pg_temp.j('ok'), pg_temp.ids('ok', 1, 2), 'approved')::text);
insert into t_calls values ('reject3', public.plan_items_set_status('a1310101-0000-0000-0000-000000000001', pg_temp.j('ok'), pg_temp.ids('ok', 3, 3), 'rejected')::text);
insert into t_calls values ('back2', public.plan_items_set_status('a1310101-0000-0000-0000-000000000001', pg_temp.j('ok'), pg_temp.ids('ok', 2, 2), 'draft')::text);
reset role;
insert into t_results (who, test, actual, expected) values
  ('status', 'approve two items on a flag report: 2 changed, replay changes 0',
     (select v from t_calls where k = 'approve12') || '/' || (select v from t_calls where k = 'approve12_again'), '2/0'),
  ('status', 'reject one and send one back to draft: 1 changed each',
     (select v from t_calls where k = 'reject3') || '/' || (select v from t_calls where k = 'back2'), '1/1'),
  ('status', 'counts: approved 1, rejected 1, draft 4',
     pg_temp.cnt('ok', 'approved') || '/' || pg_temp.cnt('ok', 'rejected') || '/' || pg_temp.cnt('ok', 'draft'), '1/1/4');

-- approve_clean: of the 4 drafts (i2, i4 clean; i5, i6 flagged) only clean ones; i2 and i4 -> 2 changed
set role service_role;
insert into t_calls values ('clean', public.plan_items_approve_clean('a1310101-0000-0000-0000-000000000001', pg_temp.j('ok'))::text);
insert into t_calls values ('clean_again', public.plan_items_approve_clean('a1310101-0000-0000-0000-000000000001', pg_temp.j('ok'))::text);
reset role;
insert into t_results (who, test, actual, expected) values
  ('clean', 'approve-clean approves only draft items without flags; replay 0',
     (select v from t_calls where k = 'clean') || '/' || (select v from t_calls where k = 'clean_again'), '2/0'),
  ('clean', 'flagged items stay draft; the rejected one stays rejected',
     (select count(*)::text from public.plan_items where map_run_id = pg_temp.j('ok') and status = 'draft' and cardinality(flags) > 0) || '/' || pg_temp.cnt('ok', 'rejected'), '2/1');

-- ===========================================================================
-- Gates
-- ===========================================================================
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('gate', 'a red (fail) report blocks approval (PM003) but not reject / draft',
     pg_temp.try(format($q$select public.plan_items_set_status('a1310101-0000-0000-0000-000000000001', %L, %L, 'approved')$q$, pg_temp.j('red'), pg_temp.ids('red', 1, 2))) || '/' ||
     pg_temp.try(format($q$select public.plan_items_set_status('a1310101-0000-0000-0000-000000000001', %L, %L, 'rejected')$q$, pg_temp.j('red'), pg_temp.ids('red', 1, 2))) || '/' ||
     pg_temp.try(format($q$select public.plan_items_set_status('a1310101-0000-0000-0000-000000000001', %L, %L, 'draft')$q$, pg_temp.j('red'), pg_temp.ids('red', 1, 2))),
     'err:PM003/ok/ok'),
  ('gate', 'approve-clean on a red report is blocked too',
     pg_temp.try(format($q$select public.plan_items_approve_clean('a1310101-0000-0000-0000-000000000001', %L)$q$, pg_temp.j('red'))), 'err:PM003'),
  ('gate', 'a run that is not finished cannot have items approved (PM003)',
     pg_temp.try(format($q$select public.plan_items_set_status('a1310101-0000-0000-0000-000000000001', %L, %L, 'approved')$q$, pg_temp.j('live'), pg_temp.ids('live', 1, 2))), 'err:PM003'),
  ('gate', 'a stranger (not a member) is refused (42501), for both functions',
     pg_temp.try(format($q$select public.plan_items_set_status('b1310101-0000-0000-0000-000000000002', %L, %L, 'rejected')$q$, pg_temp.j('ok'), pg_temp.ids('ok', 1, 2))) || '/' ||
     pg_temp.try(format($q$select public.plan_items_approve_clean('b1310101-0000-0000-0000-000000000002', %L)$q$, pg_temp.j('ok'))), 'err:42501/err:42501'),
  ('gate', 'unknown run (PM004); unknown status (22023); more than 1000 ids (22023)',
     pg_temp.try($q$select public.plan_items_set_status('a1310101-0000-0000-0000-000000000001', gen_random_uuid(), '{}', 'approved')$q$) || '/' ||
     pg_temp.try(format($q$select public.plan_items_set_status('a1310101-0000-0000-0000-000000000001', %L, '{}', 'published')$q$, pg_temp.j('ok'))) || '/' ||
     pg_temp.try(format($q$select public.plan_items_set_status('a1310101-0000-0000-0000-000000000001', %L, (select array_agg(gen_random_uuid()) from generate_series(1, 1001)), 'rejected')$q$, pg_temp.j('ok'))),
     'err:PM004/err:22023/err:22023');
reset role;
insert into t_results (who, test, actual, expected) values
  ('gate', 'the stranger changed nothing; the red run is unchanged (all draft)',
     pg_temp.cnt('ok', 'rejected') || '/' || pg_temp.cnt('red', 'draft'), '1/6');

-- items of another run are never touched, even when their ids are passed
set role service_role;
insert into t_calls values ('cross', public.plan_items_set_status('a1310101-0000-0000-0000-000000000001', pg_temp.j('ok'), pg_temp.ids('red', 1, 6), 'rejected')::text);
reset role;
insert into t_results (who, test, actual, expected) values
  ('gate', 'ids of another run are ignored (0 changed, the other run untouched)',
     (select v from t_calls where k = 'cross') || '/' || pg_temp.cnt('red', 'draft'), '0/6');

-- authenticated users cannot call the functions (service role only)
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('privilege', 'authenticated cannot execute plan_items_set_status / approve_clean',
     pg_temp.try(format($q$select public.plan_items_set_status('a1310101-0000-0000-0000-000000000001', %L, '{}', 'rejected')$q$, pg_temp.j('ok'))) || '/' ||
     pg_temp.try(format($q$select public.plan_items_approve_clean('a1310101-0000-0000-0000-000000000001', %L)$q$, pg_temp.j('ok'))), 'err:42501/err:42501');
reset role;

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a1310101-0000-0000-0000-000000000001','b1310101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a1310101-0000-0000-0000-000000000001','b1310101-0000-0000-0000-000000000002');

select n, who, test, actual, expected, (actual = expected) as pass from t_results
union all
select 9999, 'ALL CHECKS', (select count(*) filter (where actual = expected) from t_results)::text || ' of ' || (select count(*) from t_results)::text || ' passed', '', '',
       (select bool_and(actual = expected) from t_results)
order by 1;
