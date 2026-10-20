-- rls_0011.sql — tests for migration 0011 (auto map size: ceiling hold, settlement at the real size)
--
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0008-0011 are applied). Safe to re-run.
-- Creates one throw-away user with a workspace and removes everything at the end. No psql meta-commands.
--
-- EXPECTED OUTPUT: every row pass = true; last row  ALL CHECKS | <N> of <N> passed | (blank) | (blank) | true

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id = 'a1110101-0000-0000-0000-000000000001';
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id = 'a1110101-0000-0000-0000-000000000001';

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('a1110101-0000-0000-0000-000000000001','authenticated','authenticated','a11@example.test', now());
create temp table t_ws as select id as ws from public.workspaces where owner_id = 'a1110101-0000-0000-0000-000000000001';
grant select on t_ws to anon, authenticated, service_role;
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to anon, authenticated, service_role;
create function pg_temp.ws() returns uuid language sql as $$ select ws from t_ws $$;
create function pg_temp.j(k text) returns uuid language sql as $$ select v from t_ids where k = $1 $$;
grant execute on function pg_temp.ws(), pg_temp.j(text) to anon, authenticated, service_role;

set role service_role;
select public.credit_adjust(pg_temp.ws(), 100, 'test_grant', 'test-0011:' || pg_temp.ws()::text, 'test', 'x');
reset role;
-- balance now = trial grant + 100; remember it so the checks do not depend on the trial amount
create temp table t_bal as select available as start_bal from public.credit_balance(pg_temp.ws());
grant select on t_bal to anon, authenticated, service_role;

set role service_role;
insert into t_ids values ('auto', public.map_run_create_sized(pg_temp.ws(), 'a1110101-0000-0000-0000-000000000001', 'peinados', 'es', 'es-MX', 'auto', 20, 200, 'fast', 'k-a11-auto'));
insert into t_ids values ('custom', public.map_run_create_sized(pg_temp.ws(), 'a1110101-0000-0000-0000-000000000001', 'recetas', 'es', 'es-MX', 'custom', 20, 50, 'fast', 'k-a11-custom'));
insert into t_ids values ('autofail', public.map_run_create_sized(pg_temp.ws(), 'a1110101-0000-0000-0000-000000000001', 'tatuajes', 'es', 'es-MX', 'auto', 20, 100, 'fast', 'k-a11-fail'));
reset role;

-- ===========================================================================
-- Creation
-- ===========================================================================
insert into t_results (who, test, actual, expected) values
  ('create', 'size and ceiling are stored; auto ignores the given minimum (10); custom keeps it',
     (select r.params ->> 'size' || '/' || (r.params ->> 'ceiling') || '/' || r.target_min || '/' || r.target_max from public.map_runs r where r.id = pg_temp.j('auto')) || ' ' ||
     (select r.params ->> 'size' || '/' || r.target_min || '/' || r.target_max from public.map_runs r where r.id = pg_temp.j('custom')),
     'auto/200/10/200 custom/20/50'),
  ('create', 'credits are held for the ceiling: auto 200 -> 50, custom 50 -> 20, auto 100 -> 30',
     (select r.credit_amount::text from public.map_runs r where r.id = pg_temp.j('auto')) || '/' ||
     (select r.credit_amount::text from public.map_runs r where r.id = pg_temp.j('custom')) || '/' ||
     (select r.credit_amount::text from public.map_runs r where r.id = pg_temp.j('autofail')), '50/20/30'),
  ('create', 'the same key returns the same run and holds nothing twice',
     ((select public.map_run_create_sized(pg_temp.ws(), 'a1110101-0000-0000-0000-000000000001', 'peinados', 'es', 'es-MX', 'auto', 20, 200, 'fast', 'k-a11-auto') ) = pg_temp.j('auto'))::text, 'true');
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('create', 'an unknown size is refused (22023)',
     pg_temp.try($q$select public.map_run_create_sized(pg_temp.ws(), 'a1110101-0000-0000-0000-000000000001', 'x1', 'es', 'es-MX', 'huge', 20, 50, 'fast', 'k-a11-bad')$q$), 'err:22023');
reset role;

-- ===========================================================================
-- Settlement of an auto run: 12 plan items -> price 10 + 5 x ceil(12/25) = 15 instead of 50
-- ===========================================================================
insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, seq, status)
select pg_temp.ws(), pg_temp.j('auto'), 'c' || g, 'c' || g, 'es', 'test', g, 'primary' from generate_series(1, 12) g;
insert into public.plan_items (workspace_id, project_id, map_run_id, primary_kw_id, keyword, article_type, position)
select pg_temp.ws(), (select project_id from public.map_runs where id = pg_temp.j('auto')), pg_temp.j('auto'), c.id, c.raw, 'A', c.seq
from public.kw_candidates c where c.map_run_id = pg_temp.j('auto');

set role service_role;
select public.map_run_finish(pg_temp.j('auto'), 'succeeded');
reset role;
insert into t_results (who, test, actual, expected) values
  ('settle', 'status succeeded and the run now records the real price (15)',
     (select r.status || '/' || r.credit_amount from public.map_runs r where r.id = pg_temp.j('auto')), 'succeeded/15'),
  ('settle', 'the big hold is released, the exact amount is committed',
     (select string_agg(l.status || ':' || (-l.delta), ',' order by l.created_at) from public.credit_ledger l where l.ref_type = 'map_run' and l.ref_id = pg_temp.j('auto')::text), 'released:50,committed:15'),
  ('settle', 'the run points at the committed row',
     (select l.status from public.credit_ledger l join public.map_runs r on r.credit_ledger_id = l.id where r.id = pg_temp.j('auto')), 'committed');
set role service_role;
select public.map_run_finish(pg_temp.j('auto'), 'succeeded');
reset role;
insert into t_results (who, test, actual, expected) values
  ('settle', 'finishing again changes nothing (replay-safe)',
     (select count(*)::text from public.credit_ledger l where l.ref_type = 'map_run' and l.ref_id = pg_temp.j('auto')::text), '2');

-- an auto run whose real price equals the held price is not re-booked; a custom run is charged as before
set role service_role;
select public.map_run_finish(pg_temp.j('custom'), 'succeeded');
reset role;
insert into t_results (who, test, actual, expected) values
  ('settle', 'custom run: one ledger row, committed in full (20)',
     (select string_agg(l.status || ':' || (-l.delta), ',') from public.credit_ledger l where l.ref_type = 'map_run' and l.ref_id = pg_temp.j('custom')::text), 'committed:20');

-- failure releases everything, no settlement
set role service_role;
select public.map_run_finish(pg_temp.j('autofail'), 'failed', 'test');
reset role;
insert into t_results (who, test, actual, expected) values
  ('settle', 'failed auto run: only the original hold, released',
     (select string_agg(l.status || ':' || (-l.delta), ',') from public.credit_ledger l where l.ref_type = 'map_run' and l.ref_id = pg_temp.j('autofail')::text), 'released:30'),
  ('settle', 'balance = start - 15 (auto, real size) - 20 (custom)',
     ((select available from public.credit_balance(pg_temp.ws())) = (select start_bal from t_bal) - 35)::text, 'true');

-- an auto run with a tiny result never pays less than the base price
create temp table t_ids2 (v uuid);
grant all on t_ids2 to anon, authenticated, service_role;
set role service_role;
insert into t_ids2 values (public.map_run_create_sized(pg_temp.ws(), 'a1110101-0000-0000-0000-000000000001', 'vacio', 'es', 'es-MX', 'auto', 20, 200, 'fast', 'k-a11-empty'));
select public.map_run_finish((select v from t_ids2), 'succeeded');
reset role;
insert into t_results (who, test, actual, expected) values
  ('settle', 'zero plan items still costs the base price (15), never 0',
     (select r.credit_amount::text from public.map_runs r where r.id = (select v from t_ids2)), '15');

-- ===========================================================================
-- Admin entry point
-- ===========================================================================
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('admin', 'a non-superadmin is refused (42501)',
     pg_temp.try($q$select public.admin_map_run_create_sized('a1110101-0000-0000-0000-000000000001', pg_temp.ws(), 'x2', 'es', 'es-MX', 'auto', 20, 50, 'fast', 'k-a11-adm')$q$), 'err:42501');
reset role;

-- ===========================================================================
-- Cleanup + summary
-- ===========================================================================
reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id = 'a1110101-0000-0000-0000-000000000001';
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id = 'a1110101-0000-0000-0000-000000000001';

select n, who, test, actual, expected, (actual = expected) as pass from t_results
union all
select 9999, 'ALL CHECKS', (select count(*) filter (where actual = expected) from t_results)::text || ' of ' || (select count(*) from t_results)::text || ' passed', '', '',
       (select bool_and(actual = expected) from t_results)
order by 1;
