-- rls_0012.sql — tests for migration 0012 (stage timeline in map_runs.stats)
--
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0008-0012 are applied). Safe to re-run.
-- EXPECTED OUTPUT: every row pass = true; last row  ALL CHECKS | <N> of <N> passed | (blank) | (blank) | true

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id = 'a1210101-0000-0000-0000-000000000001';
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id = 'a1210101-0000-0000-0000-000000000001';

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('a1210101-0000-0000-0000-000000000001','authenticated','authenticated','a12@example.test', now());
create temp table t_ws as select id as ws from public.workspaces where owner_id = 'a1210101-0000-0000-0000-000000000001';
grant select on t_ws to anon, authenticated, service_role;
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to anon, authenticated, service_role;
create function pg_temp.j(k text) returns uuid language sql as $$ select v from t_ids where k = $1 $$;
grant execute on function pg_temp.j(text) to anon, authenticated, service_role;

set role service_role;
insert into t_ids values ('run', public.map_run_create((select ws from t_ws), 'a1210101-0000-0000-0000-000000000001', 'peinados', 'es', 'es-MX', 20, 50, 'fast', 'k-a12-1'));
select public.map_run_set_stage(pg_temp.j('run'), 's1_facets');
select public.map_run_set_stage(pg_temp.j('run'), 's1_facets');
select public.map_run_set_stage(pg_temp.j('run'), 's2_expand');
select public.map_run_set_stage(pg_temp.j('run'), 's3_normalize');
select public.map_run_set_stage(pg_temp.j('run'), 's3_normalize');
reset role;

insert into t_results (who, test, actual, expected) values
  ('timeline', 'a new stage is appended once; the same stage again adds nothing (the run starts in s1_facets, so it is not repeated)',
     (select string_agg(e ->> 'stage', ',' order by o) from public.map_runs r, jsonb_array_elements(r.stats -> 'timeline') with ordinality as t(e, o) where r.id = pg_temp.j('run')),
     's2_expand,s3_normalize'),
  ('timeline', 'every entry has a parsable UTC timestamp, in order',
     (select (bool_and((e ->> 'at') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') and (array_agg(e ->> 'at' order by o) = array_agg(e ->> 'at' order by e ->> 'at')))::text
        from public.map_runs r, jsonb_array_elements(r.stats -> 'timeline') with ordinality as t(e, o) where r.id = pg_temp.j('run')), 'true'),
  ('timeline', 'stage and status still follow the call',
     (select stage || '/' || status from public.map_runs where id = pg_temp.j('run')), 's3_normalize/running'),
  ('timeline', 'the timeline key exists in stats',
     (select (stats ? 'timeline')::text from public.map_runs where id = pg_temp.j('run')), 'true');

-- a finished run is never touched
set role service_role;
select public.map_run_finish(pg_temp.j('run'), 'failed', 'test');
select public.map_run_set_stage(pg_temp.j('run'), 's9_verify');
reset role;
insert into t_results (who, test, actual, expected) values
  ('timeline', 'set_stage on a failed run changes nothing',
     (select r.status || '/' || r.stage || '/' || jsonb_array_length(r.stats -> 'timeline') from public.map_runs r where r.id = pg_temp.j('run')), 'failed/s3_normalize/2');

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id = 'a1210101-0000-0000-0000-000000000001';
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id = 'a1210101-0000-0000-0000-000000000001';

select n, who, test, actual, expected, (actual = expected) as pass from t_results
union all
select 9999, 'ALL CHECKS', (select count(*) filter (where actual = expected) from t_results)::text || ' of ' || (select count(*) from t_results)::text || ' passed', '', '',
       (select bool_and(actual = expected) from t_results)
order by 1;
