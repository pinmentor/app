-- rls_0020.sql — tests for migration 0020 (articles: meta_description, schema_json, links)
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0008-0020 are applied). Safe to re-run.
-- Supabase runs the whole file as ONE transaction; nothing here depends on now() ordering.
-- EXPECTED OUTPUT: every row pass = true; last row  ALL CHECKS | <N> of <N> passed | (blank) | (blank) | true

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a2010101-0000-0000-0000-000000000001','b2010101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a2010101-0000-0000-0000-000000000001','b2010101-0000-0000-0000-000000000002');

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('a2010101-0000-0000-0000-000000000001','authenticated','authenticated','a20@example.test', now()),
  ('b2010101-0000-0000-0000-000000000002','authenticated','authenticated','b20@example.test', now());
create temp table t_ws as select owner_id as uid, id as ws from public.workspaces
  where owner_id in ('a2010101-0000-0000-0000-000000000001','b2010101-0000-0000-0000-000000000002');
grant select on t_ws to anon, authenticated, service_role;
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to anon, authenticated, service_role;
create function pg_temp.wsa() returns uuid language sql as $$ select ws from t_ws where uid = 'a2010101-0000-0000-0000-000000000001' $$;
create function pg_temp.j(k text) returns uuid language sql as $$ select v from t_ids where k = $1 $$;
create function pg_temp.ua() returns uuid language sql as $$ select 'a2010101-0000-0000-0000-000000000001'::uuid $$;
grant execute on function pg_temp.wsa(), pg_temp.j(text), pg_temp.ua() to anon, authenticated, service_role;

set role service_role;
insert into t_ids values ('run', public.map_run_create(pg_temp.wsa(), pg_temp.ua(), 'peinados', 'es', 'es-MX', 20, 50, 'fast', 'k-a20-run'));
reset role;
insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, seq, status)
select pg_temp.wsa(), pg_temp.j('run'), 'kw1', 'kw1', 'es', 'test', 1, 'primary';
insert into public.plan_items (workspace_id, project_id, map_run_id, primary_kw_id, keyword, article_type, position, title, list_count)
select pg_temp.wsa(), r.project_id, r.id, c.id, c.raw, 'A', 1, 'Title 1', 7
from public.map_runs r join public.kw_candidates c on c.map_run_id = r.id where r.id = pg_temp.j('run');
insert into t_ids select 'i1', id from public.plan_items where map_run_id = pg_temp.j('run');
insert into public.batches (workspace_id, project_id, map_run_id, name, origin, status)
select pg_temp.wsa(), project_id, id, 'B20', 'manual', 'completed' from public.map_runs where id = pg_temp.j('run');
insert into t_ids select 'b', id from public.batches where map_run_id = pg_temp.j('run');
insert into public.articles (workspace_id, project_id, map_run_id, batch_id, plan_item_id, keyword, locale, status, outline)
select pg_temp.wsa(), project_id, map_run_id, pg_temp.j('b'), id, keyword, 'es-MX', 'writing', '{"n":7}'::jsonb from public.plan_items where id = pg_temp.j('i1');
create function pg_temp.art() returns uuid language sql as $$ select id from public.articles where plan_item_id = pg_temp.j('i1') $$;
grant execute on function pg_temp.art() to anon, authenticated, service_role;
create temp table t_calls (k text primary key, v text);
grant all on t_calls to anon, authenticated, service_role;
create temp table t_before as select meta_description is null as meta_null, schema_json is null as schema_null, links::text as links from public.articles where id = pg_temp.art();

set role service_role;
update public.articles set meta_description = 'A short description.', schema_json = '[{"@type":"Article"}]'::jsonb, links = '[{"plan_item_id":"x","role":"pillar"}]'::jsonb where id = pg_temp.art();
insert into t_calls values ('long', pg_temp.try(format($q$update public.articles set meta_description = %L where id = %L$q$, repeat('x', 401), pg_temp.art())));
insert into t_calls values ('fin', public.article_finish(pg_temp.art(), 'ready', null, '{"word_count":100}'::jsonb));
reset role;
insert into t_results (who, test, actual, expected) values
  ('columns', 'new columns default to null / null / an empty list',
     (select meta_null::text || '/' || schema_null::text || '/' || links from t_before), 'true/true/[]'),
  ('columns', 'the service role writes them; a meta description over 400 characters is refused (23514)',
     (select meta_description || '/' || (schema_json -> 0 ->> '@type') || '/' || (links -> 0 ->> 'role') from public.articles where id = pg_temp.art()) || '/' || (select v from t_calls where k = 'long'),
     'A short description./Article/pillar/err:23514'),
  ('finish', 'article_finish (unchanged) keeps what the assemble step stored',
     (select v from t_calls where k = 'fin') || '/' || (select meta_description || '/' || (schema_json -> 0 ->> '@type') from public.articles where id = pg_temp.art()), 'ready/A short description./Article');

select set_config('request.jwt.claims', '{"sub":"a2010101-0000-0000-0000-000000000001","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'a2010101-0000-0000-0000-000000000001', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('A', 'a member reads the new columns of own article', (select (meta_description is not null)::text || '/' || (schema_json is not null)::text from public.articles where id = pg_temp.art()), 'true/true'),
  ('A', 'cannot write them',
     pg_temp.try(format($q$update public.articles set meta_description = 'hack' where id = %L$q$, pg_temp.art())), 'err:42501');
reset role;
select set_config('request.jwt.claims', '{"sub":"b2010101-0000-0000-0000-000000000002","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'b2010101-0000-0000-0000-000000000002', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('B', 'a stranger sees no article', (select count(*)::text from public.articles), '0');
reset role;
select set_config('request.jwt.claims', '{}', false);

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a2010101-0000-0000-0000-000000000001','b2010101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a2010101-0000-0000-0000-000000000001','b2010101-0000-0000-0000-000000000002');

select n, who, test, actual, expected, (actual = expected) as pass from t_results
union all
select 9999, 'ALL CHECKS', (select count(*) filter (where actual = expected) from t_results)::text || ' of ' || (select count(*) from t_results)::text || ' passed', '', '',
       (select bool_and(actual = expected) from t_results)
order by 1;
