-- rls_0022.sql — tests for migration 0022 (WordPress publish status, live internal links)
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0008-0022 are applied). Safe to re-run.
-- Runs as ONE transaction on Supabase; nothing here depends on now() ordering.
-- EXPECTED OUTPUT: every row pass = true; last row  ALL CHECKS | <N> of <N> passed | (blank) | (blank) | true

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a2210101-0000-0000-0000-000000000001','b2210101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a2210101-0000-0000-0000-000000000001','b2210101-0000-0000-0000-000000000002');

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('a2210101-0000-0000-0000-000000000001','authenticated','authenticated','a22@example.test', now()),
  ('b2210101-0000-0000-0000-000000000002','authenticated','authenticated','b22@example.test', now());
create temp table t_ws as select owner_id as uid, id as ws from public.workspaces
  where owner_id in ('a2210101-0000-0000-0000-000000000001','b2210101-0000-0000-0000-000000000002');
grant select on t_ws to anon, authenticated, service_role;
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to anon, authenticated, service_role;
create temp table t_calls (k text primary key, v text);
grant all on t_calls to anon, authenticated, service_role;
create function pg_temp.wsa() returns uuid language sql as $$ select ws from t_ws where uid = 'a2210101-0000-0000-0000-000000000001' $$;
create function pg_temp.wsb() returns uuid language sql as $$ select ws from t_ws where uid = 'b2210101-0000-0000-0000-000000000002' $$;
create function pg_temp.j(k text) returns uuid language sql as $$ select v from t_ids where k = $1 $$;
create function pg_temp.ua() returns uuid language sql as $$ select 'a2210101-0000-0000-0000-000000000001'::uuid $$;
create function pg_temp.ub() returns uuid language sql as $$ select 'b2210101-0000-0000-0000-000000000002'::uuid $$;
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
insert into t_ids values ('run', public.map_run_create(pg_temp.wsa(), pg_temp.ua(), 'peinados', 'es', 'es-MX', 20, 50, 'fast', 'k-a22-run'));
reset role;
insert into t_ids select 'proj', project_id from public.map_runs where id = pg_temp.j('run');
insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, seq, status)
select pg_temp.wsa(), pg_temp.j('run'), 'kw1', 'kw1', 'es', 'test', 1, 'primary';
insert into public.plan_items (workspace_id, project_id, map_run_id, primary_kw_id, keyword, article_type, position, title, list_count)
select pg_temp.wsa(), r.project_id, r.id, c.id, c.raw, 'A', 1, 'Title 1', 7 from public.map_runs r join public.kw_candidates c on c.map_run_id = r.id where r.id = pg_temp.j('run');
insert into t_ids select 'i1', id from public.plan_items where map_run_id = pg_temp.j('run');
insert into public.batches (workspace_id, project_id, map_run_id, name, origin, status)
select pg_temp.wsa(), project_id, id, 'B22', 'manual', 'completed' from public.map_runs where id = pg_temp.j('run');
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

create temp table t_ct as select 'v1.' || repeat('a', 30) as ct;
grant select on t_ct to service_role;
reset role;
update public.articles set status = 'ready' where map_run_id = pg_temp.j('run');
update public.plan_items set status = 'draft_ready' where map_run_id = pg_temp.j('run') and id in (pg_temp.j('i1'), pg_temp.j('i2'));
update public.plan_items set status = 'approved' where id = pg_temp.j('i3');
update public.articles set links = jsonb_build_array(
  jsonb_build_object('plan_item_id', pg_temp.j('i2')::text, 'role', 'pillar', 'title', 'Title 2', 'slug', 'title-2'),
  jsonb_build_object('plan_item_id', pg_temp.j('i3')::text, 'role', 'sibling', 'title', 'Title 3', 'slug', 'title-3'),
  jsonb_build_object('plan_item_id', gen_random_uuid()::text, 'role', 'child', 'title', 'Ghost', 'slug', 'ghost')) where id = pg_temp.j('art');
set role service_role;
insert into t_ids select 's1', public.site_connect(pg_temp.ua(), pg_temp.wsa(), 'S1', 'https://a.example.test', 'admin', (select ct from t_ct), 'abcd');
insert into t_ids select 's2', public.site_connect(pg_temp.ua(), pg_temp.wsa(), 'S2', 'https://b.example.test', 'admin', (select ct from t_ct), 'abcd');
insert into t_calls values ('bad_status', pg_temp.call(format($q$select public.article_wp_saved(%L, %L, %L, 1, 'u', 'trash', 'l')::text$q$, pg_temp.ua(), pg_temp.j('art2'), pg_temp.j('s1'))));
insert into t_calls values ('stranger', pg_temp.call(format($q$select public.article_wp_saved(%L, %L, %L, 1, 'u', 'draft', null)::text$q$, pg_temp.ub(), pg_temp.j('art2'), pg_temp.j('s1'))));
insert into t_calls values ('live_before', pg_temp.call(format($q$select count(*)::text from public.article_live_links(%L, %L, %L)$q$, pg_temp.ua(), pg_temp.j('art'), pg_temp.j('s1'))));
select public.article_wp_saved(pg_temp.ua(), pg_temp.j('art2'), pg_temp.j('s1'), 22, 'https://a.example.test/wp-admin/post.php?post=22&action=edit', 'draft', 'https://a.example.test/?p=22');
insert into t_calls values ('live_draft', pg_temp.call(format($q$select count(*)::text from public.article_live_links(%L, %L, %L)$q$, pg_temp.ua(), pg_temp.j('art'), pg_temp.j('s1'))));
insert into t_calls values ('item_after_draft', (select status from public.plan_items where id = pg_temp.j('i2')));
select public.article_wp_saved(pg_temp.ua(), pg_temp.j('art2'), pg_temp.j('s1'), 22, 'https://a.example.test/wp-admin/post.php?post=22&action=edit', 'publish', 'https://a.example.test/title-2/');
insert into t_calls values ('item_after_publish', (select status from public.plan_items where id = pg_temp.j('i2')));
insert into t_calls values ('stored', (select wp_status || '/' || wp_link from public.articles where id = pg_temp.j('art2')));
select public.article_wp_saved(pg_temp.ua(), pg_temp.j('art3'), pg_temp.j('s1'), 33, 'u', 'future', 'https://a.example.test/?p=33');
insert into t_calls values ('item_future_from_approved', (select status from public.plan_items where id = pg_temp.j('i3')));
insert into t_calls values ('live_one', pg_temp.call(format($q$select string_agg(l.role || ':' || l.title || ':' || l.link, ',') from public.article_live_links(%L, %L, %L) l$q$, pg_temp.ua(), pg_temp.j('art'), pg_temp.j('s1'))));
insert into t_calls values ('live_other_site', pg_temp.call(format($q$select count(*)::text from public.article_live_links(%L, %L, %L)$q$, pg_temp.ua(), pg_temp.j('art'), pg_temp.j('s2'))));
insert into t_calls values ('live_stranger', pg_temp.call(format($q$select count(*)::text from public.article_live_links(%L, %L, %L)$q$, pg_temp.ub(), pg_temp.j('art'), pg_temp.j('s1'))));
select public.article_wp_saved(pg_temp.ua(), pg_temp.j('art3'), pg_temp.j('s1'), 33, 'u', 'publish', 'https://a.example.test/title-3/');
insert into t_calls values ('live_two', pg_temp.call(format($q$select string_agg(l.role, ',') from public.article_live_links(%L, %L, %L) l$q$, pg_temp.ua(), pg_temp.j('art'), pg_temp.j('s1'))));
insert into t_calls values ('item3_published', (select status from public.plan_items where id = pg_temp.j('i3')));
reset role;
update public.articles set status = 'failed' where id = pg_temp.j('art2');
set role service_role;
insert into t_calls values ('live_after_fail', pg_temp.call(format($q$select string_agg(l.role, ',') from public.article_live_links(%L, %L, %L) l$q$, pg_temp.ua(), pg_temp.j('art'), pg_temp.j('s1'))));
reset role;

insert into t_results (who, test, actual, expected) values
  ('service', 'an unknown status is refused (22023)', (select v from t_calls where k = 'bad_status'), 'err:22023'),
  ('service', 'a non-member cannot save (42501)', (select v from t_calls where k = 'stranger'), 'err:42501'),
  ('service', 'nothing is live before anything is published', (select v from t_calls where k = 'live_before'), '0'),
  ('service', 'a DRAFT target is not a live link', (select v from t_calls where k = 'live_draft'), '0'),
  ('service', 'saving a draft leaves the plan item status alone', (select v from t_calls where k = 'item_after_draft'), 'draft_ready'),
  ('service', 'publishing moves the item to published', (select v from t_calls where k = 'item_after_publish'), 'published'),
  ('service', 'status and public link are stored', (select v from t_calls where k = 'stored'), 'publish/https://a.example.test/title-2/'),
  ('service', 'scheduling does not move an item that was not draft_ready (approved stays approved)', (select v from t_calls where k = 'item_future_from_approved'), 'approved'),
  ('service', 'only the published, planned target is a live link (ghost and scheduled are not)', (select v from t_calls where k = 'live_one'), 'pillar:Title 2:https://a.example.test/title-2/'),
  ('service', 'a link on another site does not count', (select v from t_calls where k = 'live_other_site'), '0'),
  ('service', 'a non-member cannot list live links (42501)', (select v from t_calls where k = 'live_stranger'), 'err:42501'),
  ('service', 'links come back in plan order once both are published', (select v from t_calls where k = 'live_two'), 'pillar,sibling'),
  ('service', 'publishing an approved item does not change it', (select v from t_calls where k = 'item3_published'), 'approved'),
  ('service', 'an article that is no longer ready is not linked', (select v from t_calls where k = 'live_after_fail'), 'sibling');

select set_config('request.jwt.claims', '{"sub":"a2210101-0000-0000-0000-000000000001","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'a2210101-0000-0000-0000-000000000001', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('A', 'a member reads wp_status and wp_link of own articles', (select count(*)::text from public.articles where wp_status is not null and wp_link is not null), '2'),
  ('A', 'cannot call the live-links function (service only)', pg_temp.sql_try(format($q$select * from public.article_live_links(%L, %L, %L)$q$, pg_temp.ua(), pg_temp.j('art'), pg_temp.j('s1'))), 'err:42501'),
  ('A', 'cannot write wp_status directly', pg_temp.sql_try($q$update public.articles set wp_status = 'publish'$q$), 'err:42501');
reset role;
select set_config('request.jwt.claims', '{}', false);

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a2210101-0000-0000-0000-000000000001','b2210101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a2210101-0000-0000-0000-000000000001','b2210101-0000-0000-0000-000000000002');

select n, who, test, actual, expected, (actual = expected) as pass from t_results
union all
select 9999, 'ALL CHECKS', (select count(*) filter (where actual = expected) from t_results)::text || ' of ' || (select count(*) from t_results)::text || ' passed', '', '',
       (select bool_and(actual = expected) from t_results)
order by 1;
