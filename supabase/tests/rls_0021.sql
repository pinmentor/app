-- rls_0021.sql — tests for migration 0021 (WordPress sites, send-as-draft bookkeeping)
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0008-0021 are applied). Safe to re-run.
-- Runs as ONE transaction on Supabase; nothing here depends on now() ordering.
-- EXPECTED OUTPUT: every row pass = true; last row  ALL CHECKS | <N> of <N> passed | (blank) | (blank) | true

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a2110101-0000-0000-0000-000000000001','b2110101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a2110101-0000-0000-0000-000000000001','b2110101-0000-0000-0000-000000000002');

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('a2110101-0000-0000-0000-000000000001','authenticated','authenticated','a21@example.test', now()),
  ('b2110101-0000-0000-0000-000000000002','authenticated','authenticated','b21@example.test', now());
create temp table t_ws as select owner_id as uid, id as ws from public.workspaces
  where owner_id in ('a2110101-0000-0000-0000-000000000001','b2110101-0000-0000-0000-000000000002');
grant select on t_ws to anon, authenticated, service_role;
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to anon, authenticated, service_role;
create temp table t_calls (k text primary key, v text);
grant all on t_calls to anon, authenticated, service_role;
create function pg_temp.wsa() returns uuid language sql as $$ select ws from t_ws where uid = 'a2110101-0000-0000-0000-000000000001' $$;
create function pg_temp.wsb() returns uuid language sql as $$ select ws from t_ws where uid = 'b2110101-0000-0000-0000-000000000002' $$;
create function pg_temp.j(k text) returns uuid language sql as $$ select v from t_ids where k = $1 $$;
create function pg_temp.ua() returns uuid language sql as $$ select 'a2110101-0000-0000-0000-000000000001'::uuid $$;
create function pg_temp.ub() returns uuid language sql as $$ select 'b2110101-0000-0000-0000-000000000002'::uuid $$;
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
insert into t_ids values ('run', public.map_run_create(pg_temp.wsa(), pg_temp.ua(), 'peinados', 'es', 'es-MX', 20, 50, 'fast', 'k-a21-run'));
reset role;
insert into t_ids select 'proj', project_id from public.map_runs where id = pg_temp.j('run');
insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, seq, status)
select pg_temp.wsa(), pg_temp.j('run'), 'kw1', 'kw1', 'es', 'test', 1, 'primary';
insert into public.plan_items (workspace_id, project_id, map_run_id, primary_kw_id, keyword, article_type, position, title, list_count)
select pg_temp.wsa(), r.project_id, r.id, c.id, c.raw, 'A', 1, 'Title 1', 7 from public.map_runs r join public.kw_candidates c on c.map_run_id = r.id where r.id = pg_temp.j('run');
insert into t_ids select 'i1', id from public.plan_items where map_run_id = pg_temp.j('run');
insert into public.batches (workspace_id, project_id, map_run_id, name, origin, status)
select pg_temp.wsa(), project_id, id, 'B21', 'manual', 'completed' from public.map_runs where id = pg_temp.j('run');
insert into t_ids select 'b', id from public.batches where map_run_id = pg_temp.j('run');
insert into public.articles (workspace_id, project_id, map_run_id, batch_id, plan_item_id, keyword, locale, status, outline)
select pg_temp.wsa(), project_id, map_run_id, pg_temp.j('b'), id, keyword, 'es-MX', 'writing', '{"n":7}'::jsonb from public.plan_items where id = pg_temp.j('i1');
insert into t_ids select 'art', id from public.articles where plan_item_id = pg_temp.j('i1');
create temp table t_ct as select 'v1.' || repeat('a', 30) as ct;
grant select on t_ct to service_role;

set role service_role;
-- before any site / before ready
insert into t_calls values ('target_notready', pg_temp.call(format($q$select count(*)::text from public.site_article_target(%L, %L)$q$, pg_temp.ua(), pg_temp.j('art'))));
reset role;
update public.articles set status = 'ready' where id = pg_temp.j('art');
set role service_role;
insert into t_calls values ('target_nosite', pg_temp.call(format($q$select count(*)::text from public.site_article_target(%L, %L)$q$, pg_temp.ua(), pg_temp.j('art'))));
insert into t_calls values ('http', pg_temp.call(format($q$select public.site_connect(%L, %L, 'S', 'http://a.example.test', 'u', %L, 'abcd')::text$q$, pg_temp.ua(), pg_temp.wsa(), (select ct from t_ct))));
insert into t_calls values ('stranger', pg_temp.call(format($q$select public.site_connect(%L, %L, 'S', 'https://a.example.test', 'u', %L, 'abcd')::text$q$, pg_temp.ub(), pg_temp.wsa(), (select ct from t_ct))));
insert into t_calls values ('badct', pg_temp.call(format($q$select public.site_connect(%L, %L, 'S', 'https://a.example.test', 'u', 'plain', 'abcd')::text$q$, pg_temp.ua(), pg_temp.wsa())));
insert into t_ids select 's1', public.site_connect(pg_temp.ua(), pg_temp.wsa(), 'Site one', 'https://a.example.test', 'admin', (select ct from t_ct), 'abcd');
insert into t_ids select 's1again', public.site_connect(pg_temp.ua(), pg_temp.wsa(), 'Renamed', 'https://a.example.test', 'admin2', (select ct from t_ct), 'wxyz');

insert into t_calls values ('after_reconnect', (select (select count(*) from public.sites where workspace_id = pg_temp.wsa())::text || '/' || (s.id = pg_temp.j('s1'))::text || '/' || s.wp_user || '/' || s.last4 || '/' || s.status from public.sites s where s.workspace_id = pg_temp.wsa()));
insert into t_calls values ('target_one', pg_temp.call(format($q$select (t.site_id = %L)::text || '/' || coalesce(t.wp_post_id::text, 'none') from public.site_article_target(%L, %L) t$q$, pg_temp.j('s1'), pg_temp.ua(), pg_temp.j('art'))));
insert into t_calls values ('rec_stranger', pg_temp.call(format($q$select public.site_record_test(%L, %L, true, 'ok')::text$q$, pg_temp.ub(), pg_temp.j('s1'))));
select public.site_record_test(pg_temp.ua(), pg_temp.j('s1'), true, 'ok');
insert into t_calls values ('after_test', (select status || '/' || last_test_code from public.sites where id = pg_temp.j('s1')));
insert into t_ids select 's2', public.site_connect(pg_temp.ua(), pg_temp.wsa(), 'Site two', 'https://b.example.test/blog', 'admin', (select ct from t_ct), 'abcd');
insert into t_calls values ('target_two', pg_temp.call(format($q$select count(*)::text from public.site_article_target(%L, %L)$q$, pg_temp.ua(), pg_temp.j('art'))));
select public.project_set_site(pg_temp.ua(), pg_temp.j('proj'), pg_temp.j('s2'));
insert into t_calls values ('target_proj', pg_temp.call(format($q$select (t.site_id = %L)::text from public.site_article_target(%L, %L) t$q$, pg_temp.j('s2'), pg_temp.ua(), pg_temp.j('art'))));
insert into t_ids select 'sb', public.site_connect(pg_temp.ub(), pg_temp.wsb(), 'B site', 'https://c.example.test', 'bob', (select ct from t_ct), 'bbbb');
insert into t_calls values ('cross_ws', pg_temp.call(format($q$select public.project_set_site(%L, %L, %L)::text$q$, pg_temp.ua(), pg_temp.j('proj'), pg_temp.j('sb'))));
select public.article_wp_saved(pg_temp.ua(), pg_temp.j('art'), pg_temp.j('s2'), 123, 'https://b.example.test/blog/wp-admin/post.php?post=123&action=edit');
insert into t_calls values ('saved', (select wp_post_id::text || '/' || (wp_site_id = pg_temp.j('s2'))::text || '/' || (wp_pushed_at is not null)::text from public.articles where id = pg_temp.j('art')));
insert into t_calls values ('target_post', pg_temp.call(format($q$select coalesce(t.wp_post_id::text, 'none') from public.site_article_target(%L, %L) t$q$, pg_temp.ua(), pg_temp.j('art'))));
select public.project_set_site(pg_temp.ua(), pg_temp.j('proj'), pg_temp.j('s1'));
insert into t_calls values ('target_other_site', pg_temp.call(format($q$select coalesce(t.wp_post_id::text, 'none') from public.site_article_target(%L, %L) t$q$, pg_temp.ua(), pg_temp.j('art'))));
select public.project_set_site(pg_temp.ua(), pg_temp.j('proj'), null);
select public.article_wp_saved(pg_temp.ua(), pg_temp.j('art'), pg_temp.j('s1'), 5, 'https://a.example.test/wp-admin/post.php?post=5&action=edit');
insert into t_calls values ('attached', (select (site_id = pg_temp.j('s1'))::text from public.projects where id = pg_temp.j('proj')));
select public.site_connect(pg_temp.ua(), pg_temp.wsa(), 'x' || g, 'https://x' || g || '.example.test', 'u', (select ct from t_ct), 'abcd') from generate_series(1, 3) g;
insert into t_calls values ('limit', pg_temp.call(format($q$select public.site_connect(%L, %L, 'x', 'https://x9.example.test', 'u', %L, 'abcd')::text$q$, pg_temp.ua(), pg_temp.wsa(), (select ct from t_ct))));
insert into t_calls values ('del_stranger', pg_temp.call(format($q$select public.site_delete(%L, %L)::text$q$, pg_temp.ub(), pg_temp.j('s2'))));
select public.article_wp_saved(pg_temp.ua(), pg_temp.j('art'), pg_temp.j('s2'), 9, 'https://b.example.test/wp-admin/post.php?post=9&action=edit');
select public.site_delete(pg_temp.ua(), pg_temp.j('s2'));
insert into t_calls values ('after_delete', (select coalesce(wp_site_id::text, 'null') || '/' || (select count(*)::text from public.sites where workspace_id = pg_temp.wsa()) from public.articles where id = pg_temp.j('art')));
reset role;

insert into t_results (who, test, actual, expected) values
  ('service', 'before the article is ready: PM003', (select v from t_calls where k = 'target_notready'), 'err:PM003'),
  ('service', 'ready but no site connected: PM004', (select v from t_calls where k = 'target_nosite'), 'err:PM004'),
  ('service', 'http:// address refused (23514)', (select v from t_calls where k = 'http'), 'err:23514'),
  ('service', 'a non-member cannot connect a site (42501)', (select v from t_calls where k = 'stranger'), 'err:42501'),
  ('service', 'a value that is not ciphertext is refused (23514)', (select v from t_calls where k = 'badct'), 'err:23514'),
  ('service', 'same address again updates the one site (new user, last4, status reset)', (select v from t_calls where k = 'after_reconnect'), '1/true/admin2/wxyz/untested'),
  ('service', 'one site and no project site: that site is the target, no post yet', (select v from t_calls where k = 'target_one'), 'true/none'),
  ('service', 'a non-member cannot record a test (42501)', (select v from t_calls where k = 'rec_stranger'), 'err:42501'),
  ('service', 'recording a test sets status and code', (select v from t_calls where k = 'after_test'), 'connected/ok'),
  ('service', 'two sites and none chosen: 22023', (select v from t_calls where k = 'target_two'), 'err:22023'),
  ('service', 'the project site wins', (select v from t_calls where k = 'target_proj'), 'true'),
  ('service', 'a site of another workspace cannot be attached to the project (PM004)', (select v from t_calls where k = 'cross_ws'), 'err:PM004'),
  ('service', 'article_wp_saved stores post id, site and time', (select v from t_calls where k = 'saved'), '123/true/true'),
  ('service', 'the stored post id is returned for the same site (so a second push updates it)', (select v from t_calls where k = 'target_post'), '123'),
  ('service', 'a different site does not reuse that post id', (select v from t_calls where k = 'target_other_site'), 'none'),
  ('service', 'saving with a project without a site attaches the project to the site', (select v from t_calls where k = 'attached'), 'true'),
  ('service', 'the 6th site of a workspace is refused (22023)', (select v from t_calls where k = 'limit'), 'err:22023'),
  ('service', 'a non-member cannot delete a site (42501)', (select v from t_calls where k = 'del_stranger'), 'err:42501'),
  ('service', 'deleting a site clears the article pointer and removes the site', (select v from t_calls where k = 'after_delete'), 'null/4');

select set_config('request.jwt.claims', '{"sub":"a2110101-0000-0000-0000-000000000001","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'a2110101-0000-0000-0000-000000000001', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('A', 'a member reads the safe columns of own sites', (select count(*)::text from (select id, base_url, wp_user, last4, status from public.sites) x), '4'),
  ('A', 'cannot read the ciphertext column', pg_temp.sql_try('select ciphertext from public.sites'), 'err:42501'),
  ('A', 'select * is refused too (it includes the ciphertext)', pg_temp.sql_try('select * from public.sites'), 'err:42501'),
  ('A', 'cannot insert a site directly', pg_temp.sql_try(format($q$insert into public.sites (workspace_id, name, base_url, wp_user, ciphertext, last4) values (%L, 'h', 'https://h.example.test', 'u', 'v1.%s', 'abcd')$q$, pg_temp.wsa(), repeat('a', 30))), 'err:42501'),
  ('A', 'cannot update a site directly', pg_temp.sql_try($q$update public.sites set name = 'hack'$q$), 'err:42501'),
  ('A', 'cannot call the connect function (service only)', pg_temp.sql_try(format($q$select public.site_connect(%L, %L, 'n', 'https://n.example.test', 'u', 'v1.%s', 'abcd')$q$, pg_temp.ua(), pg_temp.wsa(), repeat('a', 30))), 'err:42501'),
  ('A', 'cannot call the target function (it returns the ciphertext)', pg_temp.sql_try(format($q$select * from public.site_article_target(%L, %L)$q$, pg_temp.ua(), pg_temp.j('art'))), 'err:42501');
reset role;
select set_config('request.jwt.claims', '{"sub":"b2110101-0000-0000-0000-000000000002","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'b2110101-0000-0000-0000-000000000002', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('B', 'sees only own site, none of As', (select count(*)::text || '/' || min(name) from public.sites), '1/B site');
reset role;
select set_config('request.jwt.claims', '{}', false);

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a2110101-0000-0000-0000-000000000001','b2110101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a2110101-0000-0000-0000-000000000001','b2110101-0000-0000-0000-000000000002');

select n, who, test, actual, expected, (actual = expected) as pass from t_results
union all
select 9999, 'ALL CHECKS', (select count(*) filter (where actual = expected) from t_results)::text || ' of ' || (select count(*) from t_results)::text || ' passed', '', '',
       (select bool_and(actual = expected) from t_results)
order by 1;
