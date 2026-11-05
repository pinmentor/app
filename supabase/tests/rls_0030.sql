-- rls_0030.sql — tests for migration 0030 (site content sync)
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0021-0030 are applied). Safe to re-run.
-- Runs as ONE transaction on Supabase; nothing here depends on now() ordering.
-- EXPECTED OUTPUT: every row pass = true; last row  ALL CHECKS | <N> of <N> passed | (blank) | (blank) | true

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a3010101-0000-0000-0000-000000000001','b3010101-0000-0000-0000-000000000002','c3010101-0000-0000-0000-000000000003');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a3010101-0000-0000-0000-000000000001','b3010101-0000-0000-0000-000000000002','c3010101-0000-0000-0000-000000000003');

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('a3010101-0000-0000-0000-000000000001','authenticated','authenticated','a30@example.test', now()),
  ('b3010101-0000-0000-0000-000000000002','authenticated','authenticated','b30@example.test', now()),
  ('c3010101-0000-0000-0000-000000000003','authenticated','authenticated','c30@example.test', now());
create temp table t_ws as select owner_id as uid, id as ws from public.workspaces
  where owner_id in ('a3010101-0000-0000-0000-000000000001','b3010101-0000-0000-0000-000000000002');
grant select on t_ws to anon, authenticated, service_role;
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to anon, authenticated, service_role;
create temp table t_calls (k text primary key, v text);
grant all on t_calls to anon, authenticated, service_role;
create function pg_temp.wsa() returns uuid language sql as $$ select ws from t_ws where uid = 'a3010101-0000-0000-0000-000000000001' $$;
create function pg_temp.wsb() returns uuid language sql as $$ select ws from t_ws where uid = 'b3010101-0000-0000-0000-000000000002' $$;
create function pg_temp.j(k text) returns uuid language sql as $$ select v from t_ids where k = $1 $$;
create function pg_temp.ua() returns uuid language sql as $$ select 'a3010101-0000-0000-0000-000000000001'::uuid $$;
create function pg_temp.ub() returns uuid language sql as $$ select 'b3010101-0000-0000-0000-000000000002'::uuid $$;
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

create function pg_temp.uc() returns uuid language sql as $$ select 'c3010101-0000-0000-0000-000000000003'::uuid $$;
grant execute on function pg_temp.uc() to anon, authenticated, service_role;

insert into public.workspace_members (workspace_id, user_id, role) values (pg_temp.wsa(), pg_temp.uc(), 'member');
set role service_role;
insert into t_ids values ('sa', public.site_connect(pg_temp.ua(), pg_temp.wsa(), 'a.example.com', 'https://a.example.com', 'u', 'v1.' || repeat('x', 30), 'abcd'));
insert into t_ids values ('sb', public.site_connect(pg_temp.ub(), pg_temp.wsb(), 'b.example.com', 'https://b.example.com', 'u', 'v1.' || repeat('x', 30), 'abcd'));
reset role;
create function pg_temp.c(q text) returns text language plpgsql as $$ begin return pg_temp.call(q); end $$;
grant execute on function pg_temp.c(text) to anon, authenticated, service_role;
set role service_role;
insert into t_calls values ('start1', pg_temp.c(format($q$select public.site_content_sync_start(%L, %L, 'auto')::text$q$, pg_temp.ua(), pg_temp.j('sa'))));
insert into t_calls values ('start2', pg_temp.c(format($q$select public.site_content_sync_start(%L, %L, 'auto')::text$q$, pg_temp.ua(), pg_temp.j('sa'))));
insert into t_calls values ('start_stranger', pg_temp.c(format($q$select public.site_content_sync_start(%L, %L, 'auto')::text$q$, pg_temp.ub(), pg_temp.j('sa'))));
insert into t_calls values ('start_badmode', pg_temp.c(format($q$select public.site_content_sync_start(%L, %L, 'zzz')::text$q$, pg_temp.ub(), pg_temp.j('sb'))));
insert into t_calls values ('start_nourls', pg_temp.c(format($q$select public.site_content_sync_start(%L, %L, 'urls', '[]')::text$q$, pg_temp.ub(), pg_temp.j('sb'))));
insert into t_calls values ('start_urls', pg_temp.c(format($q$select public.site_content_sync_start(%L, %L, 'urls', '["https://b.example.com/x"]')::text$q$, pg_temp.ub(), pg_temp.j('sb'))));
insert into t_calls values ('disc', pg_temp.c(format($q$select public.site_content_discover(%L, 'sitemap', %L::jsonb)::text$q$, pg_temp.j('sa'),
  '[{"url":"https://a.example.com/p1/","url_key":"a.example.com/p1"},{"url":"https://a.example.com/p1","url_key":"a.example.com/p1"},{"url":"http://a.example.com/p2","url_key":"a.example.com/p2"},{"url":"https://a.example.com/p3/","url_key":"a.example.com/p3","title":"Tres","published_at":"2026-01-02T00:00:00Z"},{"url":"https://a.example.com/p4/","url_key":"a.example.com/p4"}]')));
insert into t_calls values ('disc_nosite', pg_temp.c(format($q$select public.site_content_discover(%L, 'sitemap', '[]')::text$q$, gen_random_uuid())));
insert into t_calls values ('disc_badsrc', pg_temp.c(format($q$select public.site_content_discover(%L, 'zzz', '[]')::text$q$, pg_temp.j('sa'))));
insert into t_calls values ('disc_manual', pg_temp.c(format($q$select public.site_content_discover(%L, 'manual', %L::jsonb)::text$q$, pg_temp.j('sa'), '[{"url":"https://a.example.com/m1/","url_key":"a.example.com/m1"}]')));
reset role;
insert into t_calls values ('rows1', (select count(*)::text || '/' || count(*) filter (where fetched_at is not null)::text from public.site_contents where site_id = pg_temp.j('sa')));
set role service_role;
insert into t_calls values ('prog1', (select total::text || '/' || done::text from public.site_content_progress(pg_temp.j('sa'), 'running')));
-- a second discovery of p3 without a title keeps the title; p1 gets read
insert into t_calls values ('disc_again', pg_temp.c(format($q$select public.site_content_discover(%L, 'sitemap', %L::jsonb)::text$q$, pg_temp.j('sa'), '[{"url":"https://a.example.com/p3/","url_key":"a.example.com/p3"}]')));
select public.site_content_save_page(pg_temp.j('sa'), '{"url_key":"a.example.com/p1","ok":true,"title":" Uno ","h1":"H uno","headings":["a","b"],"meta_description":"meta","published_at":"2026-02-03T00:00:00Z","word_count":900,"image_urls":["https://a.example.com/i.jpg","http://bad/i.jpg"],"content_hash":"h1"}');
select public.site_content_save_page(pg_temp.j('sa'), '{"url_key":"a.example.com/p3","ok":false,"content_hash":"x"}');
reset role;
insert into t_calls values ('p1', (select title || '/' || h1 || '/' || array_to_string(headings, '+') || '/' || word_count || '/' || cardinality(image_urls) || '/' || (fetched_at is not null)::text from public.site_contents where site_id = pg_temp.j('sa') and url_key = 'a.example.com/p1'));
insert into t_calls values ('p3', (select title || '/' || (fetched_at is not null)::text from public.site_contents where site_id = pg_temp.j('sa') and url_key = 'a.example.com/p3'));
insert into t_calls values ('p4_pending', (select (fetched_at is null)::text from public.site_contents where site_id = pg_temp.j('sa') and url_key = 'a.example.com/p4'));
insert into t_calls values ('job', (select type || '/' || state || '/' || (payload ->> 'mode') || '/' || (payload ->> 'step') from public.jobs where workspace_id = pg_temp.wsa() and type = 'site.sync' limit 1));
insert into t_calls values ('state1', (select content_sync_state from public.sites where id = pg_temp.j('sa')));
set role service_role;
insert into t_calls values ('prog2', (select total::text || '/' || done::text from public.site_content_progress(pg_temp.j('sa'), 'done')));
insert into t_calls values ('prog_bad', pg_temp.c(format($q$select count(*)::text from public.site_content_progress(%L, 'zzz')$q$, pg_temp.j('sa'))));
reset role;
insert into t_calls values ('state2', (select content_sync_state || '/' || (content_synced_at is not null)::text || '/' || coalesce(content_sync_error, 'null') from public.sites where id = pg_temp.j('sa')));
set role service_role;
select public.site_content_progress(pg_temp.j('sa'), 'failed', 'boom');
reset role;
insert into t_calls values ('state3', (select content_sync_state || '/' || content_sync_error from public.sites where id = pg_temp.j('sa')));
-- prune: p4 is old, manual m1 is old too but manual is never pruned
update public.site_contents set last_synced = now() - interval '2 days' where site_id = pg_temp.j('sa') and url_key in ('a.example.com/p4', 'a.example.com/m1');
set role service_role;
insert into t_calls values ('prune', pg_temp.c(format($q$select public.site_content_prune(%L, now() - interval '1 day')::text$q$, pg_temp.j('sa'))));
reset role;
insert into t_calls values ('left', (select string_agg(url_key, ',' order by url_key) from public.site_contents where site_id = pg_temp.j('sa')));
set role service_role;
insert into t_calls values ('clear_stranger', pg_temp.c(format($q$select public.site_content_clear(%L, %L)::text$q$, pg_temp.ub(), pg_temp.j('sa'))));
reset role;
insert into t_calls values ('b_rows', (select count(*)::text from public.site_contents where site_id = pg_temp.j('sb')));

insert into t_results (who, test, actual, expected) values
  ('service', 'a member starts a sync (a job id comes back)', (select (v ~ '^[0-9a-f-]{36}$')::text from t_calls where k = 'start1'), 'true'),
  ('service', 'a second start while running is refused (PM007)', (select v from t_calls where k = 'start2'), 'err:PM007'),
  ('service', 'a non-member cannot start (42501)', (select v from t_calls where k = 'start_stranger'), 'err:42501'),
  ('service', 'an unknown mode is refused (22023)', (select v from t_calls where k = 'start_badmode'), 'err:22023'),
  ('service', 'urls mode without urls is refused (22023)', (select v from t_calls where k = 'start_nourls'), 'err:22023'),
  ('service', 'urls mode with a list starts', (select (v ~ '^[0-9a-f-]{36}$')::text from t_calls where k = 'start_urls'), 'true'),
  ('service', 'the first job is a queued site.sync at the discover step', (select v from t_calls where k = 'job'), 'site.sync/queued/auto/discover'),
  ('service', 'the site shows running', (select v from t_calls where k = 'state1'), 'running'),
  ('service', 'discover: 3 rows (a repeat collapses, an http address is dropped)', (select v from t_calls where k = 'disc'), '3'),
  ('service', 'discover for an unknown site is refused (P0002)', (select v from t_calls where k = 'disc_nosite'), 'err:P0002'),
  ('service', 'discover with an unknown source is refused (22023)', (select v from t_calls where k = 'disc_badsrc'), 'err:22023'),
  ('service', 'a manual address is added', (select v from t_calls where k = 'disc_manual'), '1'),
  ('service', 'rows: p1, p3 (titled), p4, m1 = 4, one already fetched', (select v from t_calls where k = 'rows1'), '4/1'),
  ('service', 'progress counts rows and fetched ones', (select v from t_calls where k = 'prog1'), '4/1'),
  ('service', 'a second discovery of the same address counts it once', (select v from t_calls where k = 'disc_again'), '1'),
  ('service', 'a read page stores title (trimmed), h1, headings, words, only https images', (select v from t_calls where k = 'p1'), 'Uno/H uno/a+b/900/1/true'),
  ('service', 'an unreadable page keeps the old title and is marked fetched', (select v from t_calls where k = 'p3'), 'Tres/true'),
  ('service', 'a page not read yet stays pending', (select v from t_calls where k = 'p4_pending'), 'true'),
  ('service', 'done: total 4, 2 fetched (p4 and m1 still pending)', (select v from t_calls where k = 'prog2'), '4/2'),
  ('service', 'an unknown state is refused (22023)', (select v from t_calls where k = 'prog_bad'), 'err:22023'),
  ('service', 'done sets the time and no error', (select v from t_calls where k = 'state2'), 'done/true/null'),
  ('service', 'failed keeps a short error', (select v from t_calls where k = 'state3'), 'failed/boom'),
  ('service', 'prune removes the old sitemap row only', (select v from t_calls where k = 'prune'), '1'),
  ('service', 'a manual row is never pruned', (select v from t_calls where k = 'left'), 'a.example.com/m1,a.example.com/p1,a.example.com/p3'),
  ('service', 'a non-member cannot clear (42501)', (select v from t_calls where k = 'clear_stranger'), 'err:42501'),
  ('service', 'the other workspace''s site has no rows', (select v from t_calls where k = 'b_rows'), '0');

-- V6: plan_items_mark_existing
set role service_role;
select public.credit_adjust(pg_temp.wsa(), 300, 'test_grant', 'test-0030:' || pg_temp.wsa()::text, 'test', 'x');
insert into t_ids values ('run', public.map_run_create(pg_temp.wsa(), pg_temp.ua(), 'peinados', 'es', 'es-MX', 20, 50, 'fast', 'k-a30-run'));
reset role;
insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, seq, status)
select pg_temp.wsa(), pg_temp.j('run'), 'kw' || g, 'kw' || g, 'es', 'test', g, 'primary' from generate_series(1, 4) g;
insert into public.silos (workspace_id, project_id, map_run_id, name, position)
select pg_temp.wsa(), project_id, id, 'silo', 1 from public.map_runs where id = pg_temp.j('run');
insert into t_ids select 'silo', id from public.silos where map_run_id = pg_temp.j('run');
insert into public.plan_items (workspace_id, project_id, map_run_id, silo_id, primary_kw_id, keyword, article_type, position)
select pg_temp.wsa(), r.project_id, r.id, pg_temp.j('silo'), c.id, c.raw, 'A', c.seq from public.map_runs r join public.kw_candidates c on c.map_run_id = r.id where r.id = pg_temp.j('run');
insert into t_ids select 'x' || position, id from public.plan_items where map_run_id = pg_temp.j('run');
update public.silos set pillar_item_id = pg_temp.j('x1') where id = pg_temp.j('silo');
update public.plan_items set status = 'approved' where id = pg_temp.j('x4');
set role service_role;
insert into t_calls values ('mk', pg_temp.c(format($q$select public.plan_items_mark_existing(%L, %L::jsonb)::text$q$, pg_temp.j('run'),
  json_build_array(
    json_build_object('id', pg_temp.j('x1'), 'kind', 'same', 'url', 'https://a.example.com/p1/', 'title', 'Uno'),
    json_build_object('id', pg_temp.j('x2'), 'kind', 'same', 'url', 'https://a.example.com/p2/', 'title', 'Dos'),
    json_build_object('id', pg_temp.j('x3'), 'kind', 'close', 'url', 'https://a.example.com/p3/', 'title', 'Tres'),
    json_build_object('id', pg_temp.j('x4'), 'kind', 'same', 'url', 'https://a.example.com/p4/', 'title', 'Cuatro'),
    json_build_object('id', pg_temp.j('x2'), 'kind', 'bogus', 'url', 'https://a.example.com/zz/', 'title', 'Z'),
    json_build_object('id', pg_temp.j('x3'), 'kind', 'same', 'url', 'http://a.example.com/zz/', 'title', 'Z'))::text)));
insert into t_calls values ('mk_again', pg_temp.c(format($q$select public.plan_items_mark_existing(%L, %L::jsonb)::text$q$, pg_temp.j('run'),
  json_build_array(json_build_object('id', pg_temp.j('x2'), 'kind', 'same', 'url', 'https://a.example.com/p2/', 'title', 'Dos'))::text)));
insert into t_calls values ('mk_norun', pg_temp.c(format($q$select public.plan_items_mark_existing(%L, '[]'::jsonb)::text$q$, gen_random_uuid())));
insert into t_calls values ('mk_bad', pg_temp.c(format($q$select public.plan_items_mark_existing(%L, '{}'::jsonb)::text$q$, pg_temp.j('run'))));
reset role;
insert into t_results (who, test, actual, expected) values
  ('service', 'mark: 4 valid marks applied (bogus kind and http url ignored)', (select v from t_calls where k = 'mk'), '4'),
  ('service', 'the main article keeps its status but gets the flag', (select status || '/' || array_to_string(flags, '+') from public.plan_items where id = pg_temp.j('x1')), 'proposed/exists_on_site'),
  ('service', 'a proposed item with the same topic becomes already_exists with the page', (select status || '/' || array_to_string(flags, '+') || '/' || existing_url || '/' || existing_title from public.plan_items where id = pg_temp.j('x2')), 'already_exists/exists_on_site/https://a.example.com/p2//Dos'),
  ('service', 'a close page only flags', (select status || '/' || array_to_string(flags, '+') from public.plan_items where id = pg_temp.j('x3')), 'proposed/similar_on_site'),
  ('service', 'an approved item is never set aside', (select status || '/' || array_to_string(flags, '+') from public.plan_items where id = pg_temp.j('x4')), 'approved/exists_on_site'),
  ('service', 'marking twice does not repeat the flag', (select array_length(flags, 1)::text from public.plan_items where id = pg_temp.j('x2')), '1'),
  ('service', 'a second run of the same mark is harmless', (select v from t_calls where k = 'mk_again'), '1'),
  ('service', 'unknown run is refused (PM004)', (select v from t_calls where k = 'mk_norun'), 'err:PM004'),
  ('service', 'marks that are not an array are refused (22023)', (select v from t_calls where k = 'mk_bad'), 'err:22023');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"a3010101-0000-0000-0000-000000000001","role":"authenticated"}', false);
insert into t_results (who, test, actual, expected) values
  ('A', 'cannot call plan_items_mark_existing', pg_temp.sql_try(format($q$select public.plan_items_mark_existing(%L, '[]')$q$, pg_temp.j('run'))), 'err:42501');
reset role;
select set_config('request.jwt.claims', '{}', false);

select set_config('request.jwt.claims', '{"sub":"a3010101-0000-0000-0000-000000000001","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'a3010101-0000-0000-0000-000000000001', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('A', 'a member reads the rows of the site', (select count(*)::text from public.site_contents where site_id = pg_temp.j('sa')), '3'),
  ('A', 'and the sync state columns', (select content_sync_state from public.sites where id = pg_temp.j('sa')), 'failed'),
  ('A', 'cannot write the table directly', pg_temp.sql_try(format($q$update public.site_contents set title = 'x' where site_id = %L$q$, pg_temp.j('sa'))), 'err:42501'),
  ('A', 'cannot call site_content_sync_start', pg_temp.sql_try(format($q$select public.site_content_sync_start(%L, %L, 'auto')$q$, pg_temp.ua(), pg_temp.j('sa'))), 'err:42501'),
  ('A', 'cannot call site_content_discover', pg_temp.sql_try(format($q$select public.site_content_discover(%L, 'sitemap', '[]')$q$, pg_temp.j('sa'))), 'err:42501'),
  ('A', 'cannot call site_content_save_page', pg_temp.sql_try(format($q$select public.site_content_save_page(%L, '{}')$q$, pg_temp.j('sa'))), 'err:42501'),
  ('A', 'cannot call site_content_progress', pg_temp.sql_try(format($q$select * from public.site_content_progress(%L, 'done')$q$, pg_temp.j('sa'))), 'err:42501'),
  ('A', 'cannot call site_content_prune', pg_temp.sql_try(format($q$select public.site_content_prune(%L, now())$q$, pg_temp.j('sa'))), 'err:42501'),
  ('A', 'cannot call site_content_clear', pg_temp.sql_try(format($q$select public.site_content_clear(%L, %L)$q$, pg_temp.ua(), pg_temp.j('sa'))), 'err:42501');
reset role;
select set_config('request.jwt.claims', '{"sub":"b3010101-0000-0000-0000-000000000002","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'b3010101-0000-0000-0000-000000000002', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('B', 'a stranger sees none of A''s rows', (select count(*)::text from public.site_contents where site_id = pg_temp.j('sa')), '0');
reset role;
select set_config('request.jwt.claims', '{}', false);
set role service_role;
insert into t_results (who, test, actual, expected) values ('service', 'a member clears the site', pg_temp.c(format($q$select public.site_content_clear(%L, %L)::text$q$, pg_temp.ua(), pg_temp.j('sa'))), '3');
reset role;
insert into t_results (who, test, actual, expected) values ('service', 'clearing resets the state', (select content_sync_state || '/' || content_sync_total from public.sites where id = pg_temp.j('sa')), 'idle/0');

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a3010101-0000-0000-0000-000000000001','b3010101-0000-0000-0000-000000000002','c3010101-0000-0000-0000-000000000003');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a3010101-0000-0000-0000-000000000001','b3010101-0000-0000-0000-000000000002','c3010101-0000-0000-0000-000000000003');

select n, who, test, actual, expected, (actual = expected) as pass from t_results
union all
select 9999, 'ALL CHECKS', (select count(*) filter (where actual = expected) from t_results)::text || ' of ' || (select count(*) from t_results)::text || ' passed', '', '',
       (select bool_and(actual = expected) from t_results)
order by 1;
