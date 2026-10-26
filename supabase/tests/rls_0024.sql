-- rls_0024.sql — tests for migration 0024 (article editing)
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0008-0024 are applied). Safe to re-run.
-- Runs as ONE transaction on Supabase; nothing here depends on now() ordering.
-- EXPECTED OUTPUT: every row pass = true; last row  ALL CHECKS | <N> of <N> passed | (blank) | (blank) | true

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a2410101-0000-0000-0000-000000000001','b2410101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a2410101-0000-0000-0000-000000000001','b2410101-0000-0000-0000-000000000002');

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('a2410101-0000-0000-0000-000000000001','authenticated','authenticated','a24@example.test', now()),
  ('b2410101-0000-0000-0000-000000000002','authenticated','authenticated','b24@example.test', now());
create temp table t_ws as select owner_id as uid, id as ws from public.workspaces
  where owner_id in ('a2410101-0000-0000-0000-000000000001','b2410101-0000-0000-0000-000000000002');
grant select on t_ws to anon, authenticated, service_role;
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to anon, authenticated, service_role;
create temp table t_calls (k text primary key, v text);
grant all on t_calls to anon, authenticated, service_role;
create function pg_temp.wsa() returns uuid language sql as $$ select ws from t_ws where uid = 'a2410101-0000-0000-0000-000000000001' $$;
create function pg_temp.wsb() returns uuid language sql as $$ select ws from t_ws where uid = 'b2410101-0000-0000-0000-000000000002' $$;
create function pg_temp.j(k text) returns uuid language sql as $$ select v from t_ids where k = $1 $$;
create function pg_temp.ua() returns uuid language sql as $$ select 'a2410101-0000-0000-0000-000000000001'::uuid $$;
create function pg_temp.ub() returns uuid language sql as $$ select 'b2410101-0000-0000-0000-000000000002'::uuid $$;
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
insert into t_ids values ('run', public.map_run_create(pg_temp.wsa(), pg_temp.ua(), 'peinados', 'es', 'es-MX', 20, 50, 'fast', 'k-a24-run'));
reset role;
insert into t_ids select 'proj', project_id from public.map_runs where id = pg_temp.j('run');
insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, seq, status)
select pg_temp.wsa(), pg_temp.j('run'), 'kw1', 'kw1', 'es', 'test', 1, 'primary';
insert into public.plan_items (workspace_id, project_id, map_run_id, primary_kw_id, keyword, article_type, position, title, list_count)
select pg_temp.wsa(), r.project_id, r.id, c.id, c.raw, 'A', 1, 'Title 1', 7 from public.map_runs r join public.kw_candidates c on c.map_run_id = r.id where r.id = pg_temp.j('run');
insert into t_ids select 'i1', id from public.plan_items where map_run_id = pg_temp.j('run');
insert into public.batches (workspace_id, project_id, map_run_id, name, origin, status)
select pg_temp.wsa(), project_id, id, 'B24', 'manual', 'completed' from public.map_runs where id = pg_temp.j('run');
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
insert into public.article_sections (article_id, workspace_id, kind, idx, content, words) values
  (pg_temp.j('art'), pg_temp.wsa(), 'intro', 0, '{"paragraphs":["old intro"]}'::jsonb, 2),
  (pg_temp.j('art'), pg_temp.wsa(), 'item', 0, '{"heading":"H","paragraphs":["old"],"bullets":[]}'::jsonb, 1);
insert into public.article_gloss (article_id, workspace_id, lang, kind, idx, content) values (pg_temp.j('art'), pg_temp.wsa(), 'bn', 'intro', 0, '{"paragraphs":["x"]}'::jsonb);
set role service_role;
insert into t_calls values ('notready', pg_temp.call(format($q$select public.article_edit_save(%L, %L, 'A new valid title', '[{"kind":"intro","idx":0,"content":{"paragraphs":["n"]},"words":1}]'::jsonb)::text$q$, pg_temp.ua(), pg_temp.j('art'))));
reset role;
update public.articles set status = 'ready' where id = pg_temp.j('art');
set role service_role;
insert into t_calls values ('stranger', pg_temp.call(format($q$select public.article_edit_save(%L, %L, 'A new valid title', '[{"kind":"intro","idx":0,"content":{"paragraphs":["n"]},"words":1}]'::jsonb)::text$q$, pg_temp.ub(), pg_temp.j('art'))));
insert into t_calls values ('short_title', pg_temp.call(format($q$select public.article_edit_save(%L, %L, 'short', '[{"kind":"intro","idx":0,"content":{"paragraphs":["n"]},"words":1}]'::jsonb)::text$q$, pg_temp.ua(), pg_temp.j('art'))));
insert into t_calls values ('empty', pg_temp.call(format($q$select public.article_edit_save(%L, %L, 'A new valid title', '[]'::jsonb)::text$q$, pg_temp.ua(), pg_temp.j('art'))));
insert into t_calls values ('missing', pg_temp.call(format($q$select public.article_edit_save(%L, %L, 'A new valid title', '[{"kind":"intro","idx":0,"content":{"paragraphs":["n"]},"words":1},{"kind":"item","idx":9,"content":{},"words":1}]'::jsonb)::text$q$, pg_temp.ua(), pg_temp.j('art'))));
insert into t_calls values ('untouched_after_fail', (select (select content::text from public.article_sections where article_id = pg_temp.j('art') and kind = 'intro') || '/' || (select count(*)::text from public.article_gloss where article_id = pg_temp.j('art'))));
insert into t_calls values ('ok', pg_temp.call(format($q$select public.article_edit_save(%L, %L, '  A new valid title  ', '[{"kind":"intro","idx":0,"content":{"paragraphs":["new intro text"]},"words":3},{"kind":"item","idx":0,"content":{"heading":"H2","paragraphs":["fresh"],"bullets":["b"]},"words":1}]'::jsonb)::text$q$, pg_temp.ua(), pg_temp.j('art'))));
reset role;
insert into t_calls values ('after', (select title || '/' || (edited_at is not null)::text from public.articles where id = pg_temp.j('art')) || '/' || (select (content -> 'paragraphs' ->> 0) || ':' || words::text from public.article_sections where article_id = pg_temp.j('art') and kind = 'intro') || '/' || (select (content ->> 'heading') from public.article_sections where article_id = pg_temp.j('art') and kind = 'item') || '/' || (select count(*)::text from public.article_gloss where article_id = pg_temp.j('art')));
insert into t_results (who, test, actual, expected) values
  ('service', 'an article that is not ready cannot be edited (PM003)', (select v from t_calls where k = 'notready'), 'err:PM003'),
  ('service', 'a non-member cannot edit (42501)', (select v from t_calls where k = 'stranger'), 'err:42501'),
  ('service', 'a title under 8 characters is refused (22023)', (select v from t_calls where k = 'short_title'), 'err:22023'),
  ('service', 'an empty section list is refused (22023)', (select v from t_calls where k = 'empty'), 'err:22023'),
  ('service', 'a section that does not exist fails the whole call (PM004)', (select v from t_calls where k = 'missing'), 'err:PM004'),
  ('service', 'after the failed call nothing changed (text and translation intact)', (select v from t_calls where k = 'untouched_after_fail'), '{"paragraphs": ["old intro"]}/1'),
  ('service', 'a valid edit reports two sections', (select v from t_calls where k = 'ok'), '2'),
  ('service', 'title trimmed, edited_at set, text and words replaced, translations deleted', (select v from t_calls where k = 'after'), 'A new valid title/true/new intro text:3/H2/0');

select set_config('request.jwt.claims', '{"sub":"a2410101-0000-0000-0000-000000000001","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'a2410101-0000-0000-0000-000000000001', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('A', 'a member reads edited_at', (select (edited_at is not null)::text from public.articles where id = pg_temp.j('art')), 'true'),
  ('A', 'cannot call article_edit_save (service only)', pg_temp.sql_try(format($q$select public.article_edit_save(%L, %L, 'A new valid title', '[{"kind":"intro","idx":0,"content":{},"words":1}]'::jsonb)$q$, pg_temp.ua(), pg_temp.j('art'))), 'err:42501'),
  ('A', 'cannot write section text directly', pg_temp.sql_try($q$update public.article_sections set content = '{}'::jsonb$q$), 'err:42501');
reset role;
select set_config('request.jwt.claims', '{}', false);

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a2410101-0000-0000-0000-000000000001','b2410101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a2410101-0000-0000-0000-000000000001','b2410101-0000-0000-0000-000000000002');

select n, who, test, actual, expected, (actual = expected) as pass from t_results
union all
select 9999, 'ALL CHECKS', (select count(*) filter (where actual = expected) from t_results)::text || ' of ' || (select count(*) from t_results)::text || ' passed', '', '',
       (select bool_and(actual = expected) from t_results)
order by 1;
