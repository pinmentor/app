-- pgvector_0009.sql — tests for migration 0009 (pgvector column, kw_set_embeddings, kw_neighbors, drop-embeddings)
--
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0008 and 0009 are applied). Safe to re-run.
-- Creates 1 throw-away user (workspace + trial credits) and one 10-item run with 5 tiny hand-made candidates; removes
-- everything at the end. NOT run in the sandbox (no pgvector there): this is the first time it executes.
--
-- EXPECTED OUTPUT: every row pass = true; last row  ALL CHECKS | <N> of <N> passed | (blank) | (blank) | true

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id = 'a9a9a9a9-0000-0000-0000-000000000001';
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id = 'a9a9a9a9-0000-0000-0000-000000000001';

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, email_confirmed_at)
values ('a9a9a9a9-0000-0000-0000-000000000001','authenticated','authenticated','a9@example.test', now());
create temp table t_ws as select id as ws from public.workspaces where owner_id = 'a9a9a9a9-0000-0000-0000-000000000001';
grant select on t_ws to anon, authenticated, service_role;
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to anon, authenticated, service_role;

insert into t_ids select 'run', public.map_run_create((select ws from t_ws), 'a9a9a9a9-0000-0000-0000-000000000001', 'vectores', 'es', 'es-MX', 10, 25, 'fast', 'pgv-1');
insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, seq, status) values
  ((select ws from t_ws), (select v from t_ids where k = 'run'), 'k0', 'k0', 'es', 'test', 0, 'raw'),
  ((select ws from t_ws), (select v from t_ids where k = 'run'), 'k1', 'k1', 'es', 'test', 1, 'raw'),
  ((select ws from t_ws), (select v from t_ids where k = 'run'), 'k2', 'k2', 'es', 'test', 2, 'raw'),
  ((select ws from t_ws), (select v from t_ids where k = 'run'), 'k3', 'k3', 'es', 'test', 3, 'merged'),
  ((select ws from t_ws), (select v from t_ids where k = 'run'), 'k4', 'k4', 'es', 'test', 4, 'raw');
create function pg_temp.cid(raw text) returns uuid language sql as $$
  select id from public.kw_candidates where kw_candidates.raw = $1 and map_run_id = (select v from t_ids where k = 'run') $$;
grant execute on function pg_temp.cid(text) to anon, authenticated, service_role;

-- k0 = (1,0)  k1 = (0.9, 0.4359) -> cosine 0.9 with k0   k2 = (0,1) -> cosine 0 with k0   k3 same as k0 but 'merged'   k4 has no vector
set role service_role;
select public.kw_set_embeddings((select v from t_ids where k = 'run'), jsonb_build_array(
  jsonb_build_object('id', pg_temp.cid('k0'), 'embedding', to_jsonb((array[1, 0] || array_fill(0, array[1534])))),
  jsonb_build_object('id', pg_temp.cid('k1'), 'embedding', to_jsonb((array[0.9, 0.43589] || array_fill(0::numeric, array[1534])))),
  jsonb_build_object('id', pg_temp.cid('k2'), 'embedding', to_jsonb((array[0, 1] || array_fill(0, array[1534])))),
  jsonb_build_object('id', pg_temp.cid('k3'), 'embedding', to_jsonb((array[1, 0] || array_fill(0, array[1534]))))));
reset role;

insert into t_results (who, test, actual, expected) values
  ('vectors', 'four vectors were stored, k4 has none',
     (select count(*) filter (where embedding is not null) || '/' || count(*) filter (where embedding is null) from public.kw_candidates where map_run_id = (select v from t_ids where k = 'run')), '4/1'),
  ('vectors', 'vectors have 1536 dimensions', (select vector_dims(embedding)::text from public.kw_candidates where id = pg_temp.cid('k0')), '1536');

set role service_role;
insert into t_results (who, test, actual, expected) values
  ('neighbors', 'min 0.6 finds only (k0,k1) with cosine ~0.9 (k2 is orthogonal; k3 is merged; k4 has no vector)',
     (select count(*) || '/' || round(min(cosine)::numeric, 2) from public.kw_neighbors((select v from t_ids where k = 'run'), 0, 10, 0.6)), '1/0.90'),
  ('neighbors', 'the pair is (k0, k1)',
     (select (a = pg_temp.cid('k0') and b = pg_temp.cid('k1'))::text from public.kw_neighbors((select v from t_ids where k = 'run'), 0, 10, 0.6)), 'true'),
  ('neighbors', 'min 0.95 finds nothing', (select count(*)::text from public.kw_neighbors((select v from t_ids where k = 'run'), 0, 10, 0.95)), '0'),
  ('neighbors', 'chunk [1,10) skips x = k0, so no pair', (select count(*)::text from public.kw_neighbors((select v from t_ids where k = 'run'), 1, 10, 0.6)), '0'),
  ('neighbors', 'min -1 returns every raw pair with vectors: (k0,k1) (k0,k2) (k1,k2)', (select count(*)::text from public.kw_neighbors((select v from t_ids where k = 'run'), 0, 10, -1)), '3'),
  ('neighbors', 'another run id returns nothing', (select count(*)::text from public.kw_neighbors(gen_random_uuid(), 0, 10, -1)), '0'),
  ('set', 'kw_set_embeddings refuses a non-array / oversize payload', pg_temp.try($q$select public.kw_set_embeddings(gen_random_uuid(), '{"a":1}'::jsonb)$q$), 'err:22023'),
  ('set', 'a wrong-size vector is rejected by the column type (any error)',
     left(pg_temp.try(format($q$select public.kw_set_embeddings(%L, jsonb_build_array(jsonb_build_object('id', %L, 'embedding', '[1,2,3]'::jsonb)))$q$, (select v from t_ids where k = 'run'), pg_temp.cid('k0'))), 4), 'err:');
reset role;

-- another run's id cannot overwrite this run's vectors
set role service_role;
select public.kw_set_embeddings(gen_random_uuid(), jsonb_build_array(jsonb_build_object('id', pg_temp.cid('k4'), 'embedding', to_jsonb((array[1, 0] || array_fill(0, array[1534]))))));
reset role;
insert into t_results (who, test, actual, expected) values
  ('set', 'a candidate id under the WRONG run id is not touched', (select (embedding is null)::text from public.kw_candidates where id = pg_temp.cid('k4')), 'true');

-- members cannot read vectors, but still read everything else
select set_config('request.jwt.claims', '{"sub":"a9a9a9a9-0000-0000-0000-000000000001","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'a9a9a9a9-0000-0000-0000-000000000001', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('member', 'can read candidate text columns', pg_temp.try($q$select raw, status, seq from public.kw_candidates$q$), 'ok'),
  ('member', 'cannot read the embedding column', pg_temp.try($q$select embedding from public.kw_candidates$q$), 'err:42501'),
  ('member', 'cannot select * (it includes embedding)', pg_temp.try($q$select * from public.kw_candidates$q$), 'err:42501'),
  ('member', 'cannot call the vector functions',
     pg_temp.try($q$select * from public.kw_neighbors(gen_random_uuid(), 0, 1, 0.5)$q$) || '/' ||
     pg_temp.try($q$select public.kw_set_embeddings(gen_random_uuid(), '[]'::jsonb)$q$) || '/' ||
     pg_temp.try($q$select public.map_run_drop_embeddings(gen_random_uuid())$q$), 'err:42501/err:42501/err:42501');
reset role;

-- drop embeddings: only primaries keep theirs
update public.kw_candidates set status = 'primary' where id in (pg_temp.cid('k0'));
update public.kw_candidates set status = 'merged', merged_into = pg_temp.cid('k0') where id = pg_temp.cid('k1');
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('drop', 'drop_embeddings clears the 3 non-primary vectors (k1, k2, k3)', public.map_run_drop_embeddings((select v from t_ids where k = 'run'))::text, '3');
reset role;
insert into t_results (who, test, actual, expected) values
  ('drop', 'the primary keeps its vector, nothing else has one',
     (select count(*) filter (where embedding is not null) || '/' || count(*) filter (where embedding is not null and status = 'primary') from public.kw_candidates where map_run_id = (select v from t_ids where k = 'run')), '1/1');

-- cleanup
delete from public.jobs where payload ->> 'mapRunId' = (select v::text from t_ids where k = 'run');
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id = 'a9a9a9a9-0000-0000-0000-000000000001';
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id = 'a9a9a9a9-0000-0000-0000-000000000001';
insert into t_results (who, test, actual, expected)
select 'cleanup', 'test user, run and candidates are gone',
       (select count(*) from auth.users where email = 'a9@example.test') || '/' ||
       (select count(*) from public.map_runs where id = (select v from t_ids where k = 'run')) || '/' ||
       (select count(*) from public.kw_candidates where raw_key in ('k0','k1','k2','k3','k4') and lang = 'es' and source = 'test'), '0/0/0';

select who, test, actual, expected, pass
from (
  select n as k, who, test, coalesce(actual, '<NULL>') as actual, expected, coalesce(actual = expected, false) as pass from t_results
  union all
  select 1000000, 'ALL CHECKS',
         (count(*) filter (where coalesce(actual = expected, false)))::text || ' of ' || count(*)::text || ' passed',
         '', '', bool_and(coalesce(actual = expected, false))
  from t_results
) s
order by k;
