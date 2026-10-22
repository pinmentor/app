-- rls_0017.sql — tests for migration 0017 (credit rates set by a superadmin, audited; measured cost per task)
--
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0017 is applied). Safe to re-run.
-- Creates 3 throw-away users (A = user, B = superadmin, C = support). Uses only the rate action 'zz_test_rate' and the task
-- name 'zz_test_task'; both are removed at the end. NO real price is touched.
-- EXPECTED OUTPUT: every row pass = true; last row  ALL CHECKS | <N> of <N> passed | (blank) | (blank) | true

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a1710101-0000-0000-0000-000000000001','b1710101-0000-0000-0000-000000000002','c1710101-0000-0000-0000-000000000003');
delete from public.admin_audit where target_type = 'credit_rate' and target_id = 'zz_test_rate';
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from public.credit_rates where action = 'zz_test_rate';
delete from public.llm_calls where task = 'zz_test_task';
delete from auth.users where id in ('a1710101-0000-0000-0000-000000000001','b1710101-0000-0000-0000-000000000002','c1710101-0000-0000-0000-000000000003');

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('a1710101-0000-0000-0000-000000000001','authenticated','authenticated','a17@example.test', now()),
  ('b1710101-0000-0000-0000-000000000002','authenticated','authenticated','b17@example.test', now()),
  ('c1710101-0000-0000-0000-000000000003','authenticated','authenticated','c17@example.test', now());
update public.profiles set role = 'superadmin' where user_id = 'b1710101-0000-0000-0000-000000000002';
update public.profiles set role = 'support'    where user_id = 'c1710101-0000-0000-0000-000000000003';

-- before anything: this migration inserted no price
insert into t_results (who, test, actual, expected) values
  ('setup', 'no article price is set by the migration (article_write absent unless the owner set it)',
     (select count(*)::text from public.credit_rates where action = 'zz_test_rate'), '0');

set role service_role;
-- superadmin sets, replaces, deletes
select public.admin_credit_rate_set('b1710101-0000-0000-0000-000000000002', 'zz_test_rate', 7, '  first guess  ', '1.2.3.4');
select public.admin_credit_rate_set('b1710101-0000-0000-0000-000000000002', 'zz_test_rate', 9, null, null);
reset role;
insert into t_results (who, test, actual, expected) values
  ('B', 'set then replace: one row, new value, note cleared, updated_by = B',
     (select count(*)::text || '/' || max(credits) || '/' || coalesce(max(note), 'null') || '/' || (max(updated_by::text) = 'b1710101-0000-0000-0000-000000000002')::text from public.credit_rates where action = 'zz_test_rate'), '1/9/null/true'),
  ('B', 'two audit rows: first before=null after=7 with the trimmed note and ip; second before=7 after=9',
     (select string_agg(coalesce(diff ->> 'before', 'null') || '>' || (diff ->> 'after') || ':' || coalesce(diff ->> 'note', '-') || ':' || coalesce(ip, '-'), ' | ' order by at, id)
        from public.admin_audit where target_type = 'credit_rate' and target_id = 'zz_test_rate' and admin_id = 'b1710101-0000-0000-0000-000000000002'),
     'null>7:first guess:1.2.3.4 | 7>9:-:-');

-- gates
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('gate', 'a plain user and a support admin cannot set or delete a rate (42501)',
     pg_temp.try($q$select public.admin_credit_rate_set('a1710101-0000-0000-0000-000000000001', 'zz_test_rate', 1)$q$) || '/' ||
     pg_temp.try($q$select public.admin_credit_rate_set('c1710101-0000-0000-0000-000000000003', 'zz_test_rate', 1)$q$) || '/' ||
     pg_temp.try($q$select public.admin_credit_rate_delete('c1710101-0000-0000-0000-000000000003', 'zz_test_rate')$q$), 'err:42501/err:42501/err:42501'),
  ('gate', 'invalid input is 22023: bad action name, negative, too large, null credits, note over 200 characters, deleting test_job',
     pg_temp.try($q$select public.admin_credit_rate_set('b1710101-0000-0000-0000-000000000002', 'Bad Name', 1)$q$) || '/' ||
     pg_temp.try($q$select public.admin_credit_rate_set('b1710101-0000-0000-0000-000000000002', 'zz_test_rate', -1)$q$) || '/' ||
     pg_temp.try($q$select public.admin_credit_rate_set('b1710101-0000-0000-0000-000000000002', 'zz_test_rate', 100001)$q$) || '/' ||
     pg_temp.try($q$select public.admin_credit_rate_set('b1710101-0000-0000-0000-000000000002', 'zz_test_rate', null)$q$) || '/' ||
     pg_temp.try(format($q$select public.admin_credit_rate_set('b1710101-0000-0000-0000-000000000002', 'zz_test_rate', 1, %L)$q$, repeat('x', 201))) || '/' ||
     pg_temp.try($q$select public.admin_credit_rate_delete('b1710101-0000-0000-0000-000000000002', 'test_job')$q$),
     'err:22023/err:22023/err:22023/err:22023/err:22023/err:22023'),
  ('gate', 'zero credits is allowed (a free action)',
     pg_temp.try($q$select public.admin_credit_rate_set('b1710101-0000-0000-0000-000000000002', 'zz_test_rate', 0)$q$), 'ok');
reset role;
insert into t_results (who, test, actual, expected) values
  ('gate', 'failed calls changed nothing: the value is 0 (the last good set), test_job still exists',
     (select credits::text from public.credit_rates where action = 'zz_test_rate') || '/' || (select count(*)::text from public.credit_rates where action = 'test_job'), '0/1');

-- delete
set role service_role;
create temp table t_calls (k text primary key, v text);
grant all on t_calls to anon, authenticated, service_role;
insert into t_calls values ('d1', public.admin_credit_rate_delete('b1710101-0000-0000-0000-000000000002', 'zz_test_rate', '9.9.9.9')::text);
insert into t_calls values ('d2', public.admin_credit_rate_delete('b1710101-0000-0000-0000-000000000002', 'zz_test_rate')::text);
reset role;
insert into t_results (who, test, actual, expected) values
  ('B', 'delete returns true once, false on replay; the row is gone; one delete audit row with before = 0',
     (select v from t_calls where k = 'd1') || '/' || (select v from t_calls where k = 'd2') || '/' ||
     (select count(*)::text from public.credit_rates where action = 'zz_test_rate') || '/' ||
     (select count(*)::text || ':' || max(diff ->> 'before') from public.admin_audit where action = 'credit_rate_delete' and target_id = 'zz_test_rate'), 'true/false/0/1:0');

-- measured cost per task: 3 ok calls (100/10, 200/30, 300/50 tokens; cost 0.01, 0.02, 0.03) + 1 failed call (cost 0.04)
insert into public.llm_calls (workspace_id, task, provider, model_key, model_id, attempt, status, input_tokens, output_tokens, cost_usd)
select (select id from public.workspaces where owner_id = 'a1710101-0000-0000-0000-000000000001'), 'zz_test_task', 'openai', 'm', 'm', 1, s, i, o, c
from (values ('ok', 100, 10, 0.01), ('ok', 200, 30, 0.02), ('ok', 300, 50, 0.03), ('error', 0, 0, 0.04)) v(s, i, o, c);
set role service_role;
create temp table t_cost as select * from public.admin_llm_cost_by_task(14) where task = 'zz_test_task';
reset role;
insert into t_results (who, test, actual, expected) values
  ('cost', 'task row: 3 ok + 1 failed; averages over ok calls only (200 in, 30 out, 0.02 usd); total counts the failed call (0.10)',
     (select ok_calls || '/' || failed_calls || '/' || avg_input_tok || '/' || avg_output_tok || '/' || avg_cost_usd::numeric(12,2) || '/' || total_cost_usd::numeric(12,2) from t_cost), '3/1/200/30/0.02/0.10'),
  ('cost', 'the day window is clamped (0 and 100000 both work)',
     pg_temp.try($q$select public.admin_llm_cost_by_task(0)$q$) || '/' || pg_temp.try($q$select public.admin_llm_cost_by_task(100000)$q$), 'ok/ok');
delete from public.llm_calls where task = 'zz_test_task';

-- privileges
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('privilege', 'authenticated cannot execute the three functions, nor write credit_rates directly',
     pg_temp.try($q$select public.admin_credit_rate_set('b1710101-0000-0000-0000-000000000002', 'zz_test_rate', 1)$q$) || '/' ||
     pg_temp.try($q$select public.admin_credit_rate_delete('b1710101-0000-0000-0000-000000000002', 'zz_test_rate')$q$) || '/' ||
     pg_temp.try($q$select public.admin_llm_cost_by_task(14)$q$) || '/' ||
     pg_temp.try($q$insert into public.credit_rates (action, credits) values ('zz_test_rate', 1)$q$), 'err:42501/err:42501/err:42501/err:42501');
reset role;

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a1710101-0000-0000-0000-000000000001','b1710101-0000-0000-0000-000000000002','c1710101-0000-0000-0000-000000000003');
delete from public.admin_audit where target_type = 'credit_rate' and target_id = 'zz_test_rate';
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from public.credit_rates where action = 'zz_test_rate';
delete from auth.users where id in ('a1710101-0000-0000-0000-000000000001','b1710101-0000-0000-0000-000000000002','c1710101-0000-0000-0000-000000000003');

select n, who, test, actual, expected, (actual = expected) as pass from t_results
union all
select 9999, 'ALL CHECKS', (select count(*) filter (where actual = expected) from t_results)::text || ' of ' || (select count(*) from t_results)::text || ' passed', '', '',
       (select bool_and(actual = expected) from t_results)
order by 1;
