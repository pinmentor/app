-- rls_0023.sql — tests for migration 0023 (Pinterest pin texts)
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0008-0023 are applied). Safe to re-run.
-- Runs as ONE transaction on Supabase; nothing here depends on now() ordering.
-- EXPECTED OUTPUT: every row pass = true; last row  ALL CHECKS | <N> of <N> passed | (blank) | (blank) | true

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a2310101-0000-0000-0000-000000000001','b2310101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a2310101-0000-0000-0000-000000000001','b2310101-0000-0000-0000-000000000002');

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('a2310101-0000-0000-0000-000000000001','authenticated','authenticated','a23@example.test', now()),
  ('b2310101-0000-0000-0000-000000000002','authenticated','authenticated','b23@example.test', now());
create temp table t_ws as select owner_id as uid, id as ws from public.workspaces
  where owner_id in ('a2310101-0000-0000-0000-000000000001','b2310101-0000-0000-0000-000000000002');
grant select on t_ws to anon, authenticated, service_role;
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to anon, authenticated, service_role;
create temp table t_calls (k text primary key, v text);
grant all on t_calls to anon, authenticated, service_role;
create function pg_temp.wsa() returns uuid language sql as $$ select ws from t_ws where uid = 'a2310101-0000-0000-0000-000000000001' $$;
create function pg_temp.wsb() returns uuid language sql as $$ select ws from t_ws where uid = 'b2310101-0000-0000-0000-000000000002' $$;
create function pg_temp.j(k text) returns uuid language sql as $$ select v from t_ids where k = $1 $$;
create function pg_temp.ua() returns uuid language sql as $$ select 'a2310101-0000-0000-0000-000000000001'::uuid $$;
create function pg_temp.ub() returns uuid language sql as $$ select 'b2310101-0000-0000-0000-000000000002'::uuid $$;
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

-- A: one project + one ready article
set role service_role;
insert into t_ids values ('run', public.map_run_create(pg_temp.wsa(), pg_temp.ua(), 'peinados', 'es', 'es-MX', 20, 50, 'fast', 'k-a23-run'));
reset role;
insert into t_ids select 'proj', project_id from public.map_runs where id = pg_temp.j('run');
insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, seq, status)
select pg_temp.wsa(), pg_temp.j('run'), 'kw1', 'kw1', 'es', 'test', 1, 'primary';
insert into public.plan_items (workspace_id, project_id, map_run_id, primary_kw_id, keyword, article_type, position, title, list_count)
select pg_temp.wsa(), r.project_id, r.id, c.id, c.raw, 'A', 1, 'Title 1', 7 from public.map_runs r join public.kw_candidates c on c.map_run_id = r.id where r.id = pg_temp.j('run');
insert into t_ids select 'i1', id from public.plan_items where map_run_id = pg_temp.j('run');
insert into public.batches (workspace_id, project_id, map_run_id, name, origin, status)
select pg_temp.wsa(), project_id, id, 'B23', 'manual', 'completed' from public.map_runs where id = pg_temp.j('run');
insert into t_ids select 'b', id from public.batches where map_run_id = pg_temp.j('run');
insert into public.articles (workspace_id, project_id, map_run_id, batch_id, plan_item_id, keyword, locale, status, outline)
select pg_temp.wsa(), project_id, map_run_id, pg_temp.j('b'), id, keyword, 'es-MX', 'writing', '{"n":7}'::jsonb from public.plan_items where id = pg_temp.j('i1');
insert into t_ids select 'art', id from public.articles where plan_item_id = pg_temp.j('i1');

insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, seq, status)
select pg_temp.wsa(), pg_temp.j('run'), 'kw' || g, 'kw' || g, 'es', 'test', g, 'primary' from generate_series(2, 3) g;
insert into public.plan_items (workspace_id, project_id, map_run_id, primary_kw_id, keyword, article_type, position, title, list_count)
select pg_temp.wsa(), r.project_id, r.id, c.id, c.raw, 'A', c.seq, 'Title ' || c.seq, 7 from public.map_runs r join public.kw_candidates c on c.map_run_id = r.id where r.id = pg_temp.j('run') and c.seq in (2, 3);
insert into t_ids select 'i' || position, id from public.plan_items where map_run_id = pg_temp.j('run') and position in (2, 3);
insert into public.articles (workspace_id, project_id, map_run_id, batch_id, plan_item_id, keyword, locale, status, outline)
select pg_temp.wsa(), project_id, map_run_id, pg_temp.j('b'), id, keyword, 'es-MX', 'writing', '{"n":7}'::jsonb from public.plan_items where id in (pg_temp.j('i2'), pg_temp.j('i3'));
insert into t_ids select 'art' || position, a.id from public.articles a join public.plan_items p on p.id = a.plan_item_id where p.map_run_id = pg_temp.j('run') and p.position in (2, 3);

create temp table t_ct as select 1;

reset role;
update public.articles set status = 'ready' where id = pg_temp.j('art');
set role service_role;
insert into t_calls values ('count0', pg_temp.call(format($q$select public.pin_copy_request(%L, %L, 0)::text$q$, pg_temp.ua(), pg_temp.j('art'))));
insert into t_calls values ('count11', pg_temp.call(format($q$select public.pin_copy_request(%L, %L, 11)::text$q$, pg_temp.ua(), pg_temp.j('art'))));
insert into t_calls values ('stranger', pg_temp.call(format($q$select public.pin_copy_request(%L, %L, 5)::text$q$, pg_temp.ub(), pg_temp.j('art'))));
reset role;
update public.articles set status = 'writing' where id = pg_temp.j('art');
set role service_role;
insert into t_calls values ('notready', pg_temp.call(format($q$select public.pin_copy_request(%L, %L, 5)::text$q$, pg_temp.ua(), pg_temp.j('art'))));
reset role;
update public.articles set status = 'ready' where id = pg_temp.j('art');
set role service_role;
select public.pin_copy_request(pg_temp.ua(), pg_temp.j('art'), 5);
insert into t_calls values ('job', (select type || '/' || (payload ->> 'count') || '/' || (payload ->> 'pinArticleId' = pg_temp.j('art')::text)::text || '/' || (payload ? 'articleId')::text from public.jobs where type = 'pin.copy' and workspace_id = pg_temp.wsa()));
select public.pin_copy_request(pg_temp.ua(), pg_temp.j('art'), 5);
insert into t_calls values ('job_replay', (select count(*)::text from public.jobs where type = 'pin.copy' and workspace_id = pg_temp.wsa()));
insert into public.pins (workspace_id, article_id, position, angle, title, description) values
  (pg_temp.wsa(), pg_temp.j('art'), 1, 'tip', 'Titulo uno', 'Descripcion uno'),
  (pg_temp.wsa(), pg_temp.j('art'), 2, 'list', 'Titulo dos', 'Descripcion dos');
insert into t_calls values ('exist', pg_temp.call(format($q$select public.pin_copy_request(%L, %L, 5)::text$q$, pg_temp.ua(), pg_temp.j('art'))));
insert into t_calls values ('dup_pos', pg_temp.sql_try($q$insert into public.pins (workspace_id, article_id, position, title, description) select workspace_id, article_id, 1, 'x', 'y' from public.pins limit 1$q$));
insert into t_calls values ('long_title', pg_temp.sql_try(format($q$insert into public.pins (workspace_id, article_id, position, title, description) values (%L, %L, 3, %L, 'd')$q$, pg_temp.wsa(), pg_temp.j('art'), repeat('x', 101))));
insert into t_ids select 'pin1', id from public.pins where position = 1 and article_id = pg_temp.j('art');
insert into t_ids select 'pin2', id from public.pins where position = 2 and article_id = pg_temp.j('art');
insert into t_calls values ('bad_status', pg_temp.call(format($q$select public.pin_set_status(%L, %L, 'posted')::text$q$, pg_temp.ua(), pg_temp.j('pin1'))));
insert into t_calls values ('set_stranger', pg_temp.call(format($q$select public.pin_set_status(%L, %L, 'approved')::text$q$, pg_temp.ub(), pg_temp.j('pin1'))));
select public.pin_set_status(pg_temp.ua(), pg_temp.j('pin1'), 'approved');
select public.pin_set_status(pg_temp.ua(), pg_temp.j('pin2'), 'rejected');
insert into t_calls values ('statuses', (select string_agg(status, ',' order by position) from public.pins where article_id = pg_temp.j('art')));
insert into t_calls values ('exist_after_approve', pg_temp.call(format($q$select public.pin_copy_request(%L, %L, 5)::text$q$, pg_temp.ua(), pg_temp.j('art'))));
select public.pin_set_status(pg_temp.ua(), pg_temp.j('pin1'), 'rejected');
reset role;
update public.jobs set state = 'succeeded', finished_at = now() where type = 'pin.copy' and workspace_id = (select ws from t_ws where uid = 'a2310101-0000-0000-0000-000000000001');
set role service_role;
select public.pin_copy_request(pg_temp.ua(), pg_temp.j('art'), 3);
insert into t_calls values ('regen', (select (select count(*) from public.pins where article_id = pg_temp.j('art'))::text || '/' || (select count(*) from public.jobs where type = 'pin.copy' and workspace_id = pg_temp.wsa())::text));
reset role;
insert into t_results (who, test, actual, expected) values
  ('service', 'count 0 refused (22023)', (select v from t_calls where k = 'count0'), 'err:22023'),
  ('service', 'count 11 refused (22023)', (select v from t_calls where k = 'count11'), 'err:22023'),
  ('service', 'a non-member cannot request pins (42501)', (select v from t_calls where k = 'stranger'), 'err:42501'),
  ('service', 'an article that is not ready is refused (PM003)', (select v from t_calls where k = 'notready'), 'err:PM003'),
  ('service', 'one pin.copy job, payload key is pinArticleId (never articleId)', (select v from t_calls where k = 'job'), 'pin.copy/5/true/false'),
  ('service', 'asking again does not queue a second job', (select v from t_calls where k = 'job_replay'), '1'),
  ('service', 'cannot ask again while non-rejected pins exist (PM003)', (select v from t_calls where k = 'exist'), 'err:PM003'),
  ('service', 'same position twice refused (23505)', (select v from t_calls where k = 'dup_pos'), 'err:23505'),
  ('service', 'a title over 100 characters refused (23514)', (select v from t_calls where k = 'long_title'), 'err:23514'),
  ('service', 'unknown status refused (22023)', (select v from t_calls where k = 'bad_status'), 'err:22023'),
  ('service', 'a non-member cannot approve (42501)', (select v from t_calls where k = 'set_stranger'), 'err:42501'),
  ('service', 'approve and reject are stored', (select v from t_calls where k = 'statuses'), 'approved,rejected'),
  ('service', 'an approved pin keeps the set (PM003)', (select v from t_calls where k = 'exist_after_approve'), 'err:PM003'),
  ('service', 'after rejecting all, a new request clears the old pins and queues a new job', (select v from t_calls where k = 'regen'), '0/2');

select set_config('request.jwt.claims', '{"sub":"a2310101-0000-0000-0000-000000000001","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'a2310101-0000-0000-0000-000000000001', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('A', 'a member reads pins of own articles (none are left after the regen)', (select count(*)::text from public.pins), '0'),
  ('A', 'cannot insert a pin', pg_temp.sql_try(format($q$insert into public.pins (workspace_id, article_id, position, title, description) values (%L, %L, 1, 'h', 'h')$q$, pg_temp.wsa(), pg_temp.j('art'))), 'err:42501'),
  ('A', 'cannot call pin_copy_request (service only)', pg_temp.sql_try(format($q$select public.pin_copy_request(%L, %L, 5)$q$, pg_temp.ua(), pg_temp.j('art'))), 'err:42501');
reset role;
reset role;
insert into public.pins (workspace_id, article_id, position, title, description) values (pg_temp.wsa(), pg_temp.j('art'), 1, 'visible', 'd');
select set_config('request.jwt.claims', '{"sub":"a2310101-0000-0000-0000-000000000001","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'a2310101-0000-0000-0000-000000000001', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values ('A', 'a member reads the pin of own article', (select count(*)::text from public.pins), '1');
reset role;
select set_config('request.jwt.claims', '{"sub":"b2310101-0000-0000-0000-000000000002","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'b2310101-0000-0000-0000-000000000002', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values ('B', 'a stranger sees no pins', (select count(*)::text from public.pins), '0');
reset role;
select set_config('request.jwt.claims', '{}', false);

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a2310101-0000-0000-0000-000000000001','b2310101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a2310101-0000-0000-0000-000000000001','b2310101-0000-0000-0000-000000000002');

select n, who, test, actual, expected, (actual = expected) as pass from t_results
union all
select 9999, 'ALL CHECKS', (select count(*) filter (where actual = expected) from t_results)::text || ' of ' || (select count(*) from t_results)::text || ' passed', '', '',
       (select bool_and(actual = expected) from t_results)
order by 1;
