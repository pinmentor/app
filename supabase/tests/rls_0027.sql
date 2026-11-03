-- rls_0027.sql — tests for migration 0027 (keyword library, maps from the user's own keywords)
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0021-0027 are applied). Safe to re-run.
-- Runs as ONE transaction on Supabase; nothing here depends on now() ordering.
-- EXPECTED OUTPUT: every row pass = true; last row  ALL CHECKS | <N> of <N> passed | (blank) | (blank) | true

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a2710101-0000-0000-0000-000000000001','b2710101-0000-0000-0000-000000000002','c2710101-0000-0000-0000-000000000003');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a2710101-0000-0000-0000-000000000001','b2710101-0000-0000-0000-000000000002','c2710101-0000-0000-0000-000000000003');

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('a2710101-0000-0000-0000-000000000001','authenticated','authenticated','a27@example.test', now()),
  ('b2710101-0000-0000-0000-000000000002','authenticated','authenticated','b27@example.test', now()),
  ('c2710101-0000-0000-0000-000000000003','authenticated','authenticated','c27@example.test', now());
create temp table t_ws as select owner_id as uid, id as ws from public.workspaces
  where owner_id in ('a2710101-0000-0000-0000-000000000001','b2710101-0000-0000-0000-000000000002');
grant select on t_ws to anon, authenticated, service_role;
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to anon, authenticated, service_role;
create temp table t_calls (k text primary key, v text);
grant all on t_calls to anon, authenticated, service_role;
create function pg_temp.wsa() returns uuid language sql as $$ select ws from t_ws where uid = 'a2710101-0000-0000-0000-000000000001' $$;
create function pg_temp.wsb() returns uuid language sql as $$ select ws from t_ws where uid = 'b2710101-0000-0000-0000-000000000002' $$;
create function pg_temp.j(k text) returns uuid language sql as $$ select v from t_ids where k = $1 $$;
create function pg_temp.ua() returns uuid language sql as $$ select 'a2710101-0000-0000-0000-000000000001'::uuid $$;
create function pg_temp.ub() returns uuid language sql as $$ select 'b2710101-0000-0000-0000-000000000002'::uuid $$;
grant execute on function pg_temp.wsa(), pg_temp.wsb(), pg_temp.j(text), pg_temp.ua(), pg_temp.ub() to anon, authenticated, service_role;
-- the stored value of a call that may fail: 'ok' or the SQLSTATE
create or replace function pg_temp.sql_try(p text) returns text language plpgsql as $$
begin execute p; return 'ok'; exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.sql_try(text) to anon, authenticated, service_role;
-- one call = one result row; the call's own SQLSTATE or its value
create or replace function pg_temp.call(p text) returns text language plpgsql as $$
declare r text;
begin execute p into r; return coalesce(r, 'null'); exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.call(text) to anon, authenticated, service_role;

create function pg_temp.kws(n integer) returns jsonb language sql as $$ select jsonb_agg('peinado numero ' || g) from generate_series(1, n) g $$;
grant execute on function pg_temp.kws(integer) to anon, authenticated, service_role;
create function pg_temp.items(n integer) returns jsonb language sql as $$ select jsonb_agg(jsonb_build_object('text', 'kw ' || g, 'norm_key', 'kw ' || g, 'tags', jsonb_build_array('t1'))) from generate_series(1, n) g $$;
grant execute on function pg_temp.items(integer) to anon, authenticated, service_role;

select public.credit_adjust(pg_temp.wsa(), 200, 'test_grant', 'test-0027:' || pg_temp.wsa()::text, 'test', 'x');

-- ===== keyword library =====
set role service_role;
insert into t_calls values ('imp1', pg_temp.call(format($q$select public.keywords_import(%L, %L, 'es', 'keyword', 'csv', null, pg_temp.items(5))::text$q$, pg_temp.ua(), pg_temp.wsa())));
insert into t_calls values ('imp2', pg_temp.call(format($q$select public.keywords_import(%L, %L, 'es', 'keyword', 'csv', null, pg_temp.items(7))::text$q$, pg_temp.ua(), pg_temp.wsa())));
insert into t_calls values ('imp_mixed', pg_temp.call(format($q$select public.keywords_import(%L, %L, 'en', 'keyword', 'manual', null, %L::jsonb)::text$q$, pg_temp.ua(), pg_temp.wsa(),
  '[{"text":"ok one","norm_key":"ok one"},{"text":"","norm_key":"x"},{"text":"no key"},"junk",{"text":"ok one","norm_key":"ok one"},{"text":"t","norm_key":"t","tags":["a","b","c","d","e","f","g","h","i","j","k"]}]')));
insert into t_calls values ('imp_stranger', pg_temp.call(format($q$select public.keywords_import(%L, %L, 'es', 'keyword', 'csv', null, pg_temp.items(1))::text$q$, pg_temp.ub(), pg_temp.wsa())));
insert into t_calls values ('imp_badlang', pg_temp.call(format($q$select public.keywords_import(%L, %L, 'fr', 'keyword', 'csv', null, pg_temp.items(1))::text$q$, pg_temp.ua(), pg_temp.wsa())));
insert into t_calls values ('imp_badsource', pg_temp.call(format($q$select public.keywords_import(%L, %L, 'es', 'keyword', 'hack', null, pg_temp.items(1))::text$q$, pg_temp.ua(), pg_temp.wsa())));
insert into t_calls values ('imp_notarray', pg_temp.call(format($q$select public.keywords_import(%L, %L, 'es', 'keyword', 'csv', null, '{}'::jsonb)::text$q$, pg_temp.ua(), pg_temp.wsa())));
insert into t_calls values ('imp_empty', pg_temp.call(format($q$select public.keywords_import(%L, %L, 'es', 'keyword', 'csv', null, '[]'::jsonb)::text$q$, pg_temp.ua(), pg_temp.wsa())));
insert into t_calls values ('imp_foreign_site', pg_temp.call(format($q$select public.keywords_import(%L, %L, 'es', 'keyword', 'csv', gen_random_uuid(), pg_temp.items(1))::text$q$, pg_temp.ua(), pg_temp.wsa())));
reset role;
insert into t_calls values ('count_after', (select count(*)::text from public.keyword_library where workspace_id = pg_temp.wsa()));
insert into t_calls values ('same_text_two_langs', (select count(*)::text from public.keyword_library where workspace_id = pg_temp.wsa() and norm_key = 'ok one'));
insert into t_ids select 'k1', id from public.keyword_library where workspace_id = pg_temp.wsa() and norm_key = 'kw 1';
set role service_role;
insert into t_calls values ('del_stranger', pg_temp.call(format($q$select public.keywords_delete(%L, %L, array[%L::uuid])::text$q$, pg_temp.ub(), pg_temp.wsa(), pg_temp.j('k1'))));
insert into t_calls values ('del_wrong_ws', pg_temp.call(format($q$select public.keywords_delete(%L, %L, array[%L::uuid])::text$q$, pg_temp.ub(), pg_temp.wsb(), pg_temp.j('k1'))));
insert into t_calls values ('del_ok', pg_temp.call(format($q$select public.keywords_delete(%L, %L, array[%L::uuid])::text$q$, pg_temp.ua(), pg_temp.wsa(), pg_temp.j('k1'))));
insert into t_calls values ('del_empty', pg_temp.call(format($q$select public.keywords_delete(%L, %L, '{}'::uuid[])::text$q$, pg_temp.ua(), pg_temp.wsa())));

-- ===== maps from own keywords =====
insert into t_calls values ('own9', pg_temp.call(format($q$select public.map_run_create_own(%L, %L, 'peinados', 'es', 'es-MX', true, 'custom', 10, 50, 'fast', 'k-own9', pg_temp.kws(9))::text$q$, pg_temp.wsa(), pg_temp.ua())));
insert into t_calls values ('own_stranger', pg_temp.call(format($q$select public.map_run_create_own(%L, %L, 'peinados', 'es', 'es-MX', true, 'custom', 10, 50, 'fast', 'k-ownx', pg_temp.kws(12))::text$q$, pg_temp.wsa(), pg_temp.ub())));
insert into t_calls values ('own_notarray', pg_temp.call(format($q$select public.map_run_create_own(%L, %L, 'peinados', 'es', 'es-MX', true, 'custom', 10, 50, 'fast', 'k-ownn', '{}'::jsonb)::text$q$, pg_temp.wsa(), pg_temp.ua())));
insert into t_calls values ('own_nums', pg_temp.call(format($q$select public.map_run_create_own(%L, %L, 'peinados', 'es', 'es-MX', false, 'custom', 10, 50, 'fast', 'k-ownm', '[1,2,3]'::jsonb)::text$q$, pg_temp.wsa(), pg_temp.ua())));
insert into t_calls values ('no_runs_so_far', (select count(*)::text from public.map_runs where workspace_id = pg_temp.wsa()));
insert into t_calls values ('own12', pg_temp.call(format($q$select public.map_run_create_own(%L, %L, 'peinados', 'es', 'es-MX', true, 'custom', 10, 50, 'fast', 'k-own12', (select jsonb_agg(x) from (select jsonb_array_elements(pg_temp.kws(12)) x union all select to_jsonb('PEINADO NUMERO 1'::text) union all select to_jsonb('   '::text)) q))::text$q$, pg_temp.wsa(), pg_temp.ua())));
reset role;
insert into t_ids select 'own', (select v::uuid from t_calls where k = 'own12');
insert into t_calls values ('own_cands', (select count(*)::text || '/' || min(source) || '/' || min(lang) from public.kw_candidates where map_run_id = pg_temp.j('own')));
insert into t_calls values ('own_run', (select stage || '/' || (params ->> 'own_only') || '/' || (params ->> 'own_count') || '/' || (params ->> 'size') || '/' || target_max || '/' || (credit_ledger_id is not null)::text from public.map_runs where id = pg_temp.j('own')));
insert into t_calls values ('own_s1', (select state from public.jobs where idempotency_key = 'map:' || pg_temp.j('own')::text || ':s1'));
insert into t_calls values ('own_s3', (select count(*)::text || '/' || min(state) || '/' || min(stage) from public.jobs where idempotency_key = 'map:' || pg_temp.j('own')::text || ':s3'));
set role service_role;
insert into t_calls values ('own_replay', pg_temp.call(format($q$select public.map_run_create_own(%L, %L, 'peinados', 'es', 'es-MX', true, 'custom', 10, 50, 'fast', 'k-own12', pg_temp.kws(20))::text$q$, pg_temp.wsa(), pg_temp.ua())));
reset role;
insert into t_calls values ('replay_cands', (select count(*)::text from public.kw_candidates where map_run_id = pg_temp.j('own')));
set role service_role;
insert into t_calls values ('exp3', pg_temp.call(format($q$select public.map_run_create_own(%L, %L, 'peinados', 'es', 'es-MX', false, 'auto', 10, 60, 'fast', 'k-exp3', pg_temp.kws(3))::text$q$, pg_temp.wsa(), pg_temp.ua())));
reset role;
insert into t_ids select 'exp', (select v::uuid from t_calls where k = 'exp3');
insert into t_calls values ('exp_cands', (select count(*)::text || '/' || min(source) from public.kw_candidates where map_run_id = pg_temp.j('exp')));
insert into t_calls values ('exp_run', (select stage || '/' || (params ->> 'size') || '/' || (params ->> 'own_count') || '/' || coalesce(params ->> 'own_only', 'null') from public.map_runs where id = pg_temp.j('exp')));
insert into t_calls values ('exp_s1', (select state from public.jobs where idempotency_key = 'map:' || pg_temp.j('exp')::text || ':s1'));

-- ===== admin entry point =====
set role service_role;
insert into t_calls values ('adm_nonadmin', pg_temp.call(format($q$select public.admin_map_run_create_own(%L, %L, 'peinados', 'es', 'es-MX', true, 'custom', 10, 50, 'fast', 'k-adm', pg_temp.kws(12))::text$q$, pg_temp.ua(), pg_temp.wsa())));
reset role;
update public.profiles set role = 'superadmin' where user_id = pg_temp.ua();
set role service_role;
insert into t_calls values ('adm_other_ws', pg_temp.call(format($q$select public.admin_map_run_create_own(%L, %L, 'peinados', 'es', 'es-MX', true, 'custom', 10, 50, 'fast', 'k-adm2', pg_temp.kws(12))::text$q$, pg_temp.ua(), pg_temp.wsb())));
insert into t_calls values ('adm_ok', pg_temp.call(format($q$select public.admin_map_run_create_own(%L, %L, 'peinados', 'es', 'es-MX', true, 'custom', 10, 50, 'fast', 'k-adm', pg_temp.kws(12))::text$q$, pg_temp.ua(), pg_temp.wsa())));
insert into t_calls values ('adm_replay', pg_temp.call(format($q$select public.admin_map_run_create_own(%L, %L, 'peinados', 'es', 'es-MX', true, 'custom', 10, 50, 'fast', 'k-adm', pg_temp.kws(12))::text$q$, pg_temp.ua(), pg_temp.wsa())));
reset role;
insert into t_calls values ('adm_same_run', (select (v = (select v from t_calls where k = 'adm_replay'))::text from t_calls where k = 'adm_ok'));
insert into t_calls values ('adm_audit', (select count(*)::text || '/' || min(diff ->> 'only_mine') from public.admin_audit where admin_id = pg_temp.ua() and action = 'map_run_create'));
insert into t_calls values ('adm_cands', (select count(*)::text from public.kw_candidates where map_run_id = (select v::uuid from t_calls where k = 'adm_ok')));

insert into t_results (who, test, actual, expected) values
  ('service', 'first import adds 5', (select v from t_calls where k = 'imp1'), '{"added": 5, "invalid": 0, "duplicates": 0}'),
  ('service', 'second import: 5 duplicates, 2 new', (select v from t_calls where k = 'imp2'), '{"added": 2, "invalid": 0, "duplicates": 5}'),
  ('service', 'bad rows are counted (empty text, no key, not an object, 11 tags) and a repeat collapses', (select v from t_calls where k = 'imp_mixed'), '{"added": 1, "invalid": 4, "duplicates": 1}'),
  ('service', 'a non-member cannot import (42501)', (select v from t_calls where k = 'imp_stranger'), 'err:42501'),
  ('service', 'an unknown language is refused (22023)', (select v from t_calls where k = 'imp_badlang'), 'err:22023'),
  ('service', 'an unknown source is refused (22023)', (select v from t_calls where k = 'imp_badsource'), 'err:22023'),
  ('service', 'items that are not an array are refused (22023)', (select v from t_calls where k = 'imp_notarray'), 'err:22023'),
  ('service', 'an empty list is refused (22023)', (select v from t_calls where k = 'imp_empty'), 'err:22023'),
  ('service', 'a site of another workspace is refused (42501)', (select v from t_calls where k = 'imp_foreign_site'), 'err:42501'),
  ('service', 'the library holds 7 + 1 rows after all that', (select v from t_calls where k = 'count_after'), '8'),
  ('service', 'the same text in two languages is allowed (different lang rows)', (select v from t_calls where k = 'same_text_two_langs'), '1'),
  ('service', 'a non-member cannot delete (42501)', (select v from t_calls where k = 'del_stranger'), 'err:42501'),
  ('service', 'deleting in a workspace you belong to does not touch another workspace''s rows', (select v from t_calls where k = 'del_wrong_ws'), '0'),
  ('service', 'a member deletes one row', (select v from t_calls where k = 'del_ok'), '1'),
  ('service', 'an empty id list is refused (22023)', (select v from t_calls where k = 'del_empty'), 'err:22023'),
  ('service', 'Only my keywords with 9 keywords is refused (22023)', (select v from t_calls where k = 'own9'), 'err:22023'),
  ('service', 'a non-member cannot start a run (42501)', (select v from t_calls where k = 'own_stranger'), 'err:42501'),
  ('service', 'keywords that are not an array are refused (22023)', (select v from t_calls where k = 'own_notarray'), 'err:22023'),
  ('service', 'keywords that are not strings are refused (22023)', (select v from t_calls where k = 'own_nums'), 'err:22023'),
  ('service', 'every refusal created no run', (select v from t_calls where k = 'no_runs_so_far'), '0'),
  ('service', 'Only my keywords: 12 distinct (a repeat and a blank are dropped), source manual, language es', (select v from t_calls where k = 'own_cands'), '12/manual/es'),
  ('service', 'the run starts at S3, own_only, size custom, ceiling = count, credits held', (select v from t_calls where k = 'own_run'), 's3_normalize/true/12/custom/12/true'),
  ('service', 'the S1 job was cancelled (no model spend in S1-S2)', (select v from t_calls where k = 'own_s1'), 'canceled'),
  ('service', 'one S3 job is queued', (select v from t_calls where k = 'own_s3'), '1/queued/s3_normalize'),
  ('service', 'a replay with the same key returns the same run', (select (v = (select v from t_calls where k = 'own12'))::text from t_calls where k = 'own_replay'), 'true'),
  ('service', 'a replay adds no keywords', (select v from t_calls where k = 'replay_cands'), '12'),
  ('service', 'Expand + mine: the 3 keywords join as manual candidates', (select v from t_calls where k = 'exp_cands'), '3/manual'),
  ('service', 'Expand + mine keeps the normal start (S1 stage, auto size, no own_only)', (select v from t_calls where k = 'exp_run'), 's1_facets/auto/3/null'),
  ('service', 'Expand + mine: the S1 job stays queued', (select v from t_calls where k = 'exp_s1'), 'queued'),
  ('service', 'a non-superadmin cannot use the admin entry (42501)', (select v from t_calls where k = 'adm_nonadmin'), 'err:42501'),
  ('service', 'a superadmin cannot start in another workspace (42501)', (select v from t_calls where k = 'adm_other_ws'), 'err:42501'),
  ('service', 'the admin entry creates one run, a replay returns it again', (select v from t_calls where k = 'adm_same_run'), 'true'),
  ('service', 'the admin run has its 12 keywords', (select v from t_calls where k = 'adm_cands'), '12'),
  ('service', 'exactly one admin_audit row, with only_mine', (select v from t_calls where k = 'adm_audit'), '1/true');

select set_config('request.jwt.claims', '{"sub":"a2710101-0000-0000-0000-000000000001","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'a2710101-0000-0000-0000-000000000001', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('A', 'a member reads the library of the workspace', (select count(*)::text from public.keyword_library), '7'),
  ('A', 'cannot write the library directly', pg_temp.sql_try($q$insert into public.keyword_library (workspace_id, text, norm_key, lang, source) select workspace_id, 'x', 'x', 'es', 'manual' from public.keyword_library limit 1$q$), 'err:42501'),
  ('A', 'cannot delete library rows directly', pg_temp.sql_try($q$delete from public.keyword_library$q$), 'err:42501'),
  ('A', 'cannot call keywords_import (service only)', pg_temp.sql_try(format($q$select public.keywords_import(%L, %L, 'es', 'keyword', 'csv', null, pg_temp.items(1))$q$, pg_temp.ua(), pg_temp.wsa())), 'err:42501'),
  ('A', 'cannot call map_run_create_own (service only)', pg_temp.sql_try(format($q$select public.map_run_create_own(%L, %L, 'x y', 'es', 'es-MX', true, 'custom', 10, 50, 'fast', 'k-no', pg_temp.kws(12))$q$, pg_temp.wsa(), pg_temp.ua())), 'err:42501'),
  ('A', 'cannot call admin_map_run_create_own (service only)', pg_temp.sql_try(format($q$select public.admin_map_run_create_own(%L, %L, 'x y', 'es', 'es-MX', true, 'custom', 10, 50, 'fast', 'k-no', pg_temp.kws(12))$q$, pg_temp.ua(), pg_temp.wsa())), 'err:42501');
reset role;
select set_config('request.jwt.claims', '{"sub":"b2710101-0000-0000-0000-000000000002","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'b2710101-0000-0000-0000-000000000002', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('B', 'a stranger sees none of A''s library', (select count(*)::text from public.keyword_library), '0');
reset role;
select set_config('request.jwt.claims', '{}', false);

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a2710101-0000-0000-0000-000000000001','b2710101-0000-0000-0000-000000000002','c2710101-0000-0000-0000-000000000003');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a2710101-0000-0000-0000-000000000001','b2710101-0000-0000-0000-000000000002','c2710101-0000-0000-0000-000000000003');

select n, who, test, actual, expected, (actual = expected) as pass from t_results
union all
select 9999, 'ALL CHECKS', (select count(*) filter (where actual = expected) from t_results)::text || ' of ' || (select count(*) from t_results)::text || ' passed', '', '',
       (select bool_and(actual = expected) from t_results)
order by 1;
