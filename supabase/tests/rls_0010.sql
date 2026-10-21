-- rls_0010.sql — tests for migration 0010 (silos, plan_items, map_snapshots, S5-S9 server functions)
--
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0008, 0009 and 0010 are applied). Safe to re-run.
-- Creates 2 throw-away users (A, B) with their own workspaces and one tiny run each (hand-made 2-D vectors padded to
-- 1536 dims), and removes everything at the end. No psql meta-commands: it runs as one query in the SQL Editor.
--
-- EXPECTED OUTPUT: every row pass = true; last row  ALL CHECKS | <N> of <N> passed | (blank) | (blank) | true

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a1010101-0000-0000-0000-000000000001','b1010101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a1010101-0000-0000-0000-000000000001','b1010101-0000-0000-0000-000000000002');

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('a1010101-0000-0000-0000-000000000001','authenticated','authenticated','a10@example.test', now()),
  ('b1010101-0000-0000-0000-000000000002','authenticated','authenticated','b10@example.test', now());
create temp table t_ws as select owner_id as uid, id as ws from public.workspaces
  where owner_id in ('a1010101-0000-0000-0000-000000000001','b1010101-0000-0000-0000-000000000002');
grant select on t_ws to anon, authenticated, service_role;
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to anon, authenticated, service_role;
create function pg_temp.wsa() returns uuid language sql as $$ select ws from t_ws where uid = 'a1010101-0000-0000-0000-000000000001' $$;
create function pg_temp.wsb() returns uuid language sql as $$ select ws from t_ws where uid = 'b1010101-0000-0000-0000-000000000002' $$;
create function pg_temp.j(k text) returns uuid language sql as $$ select v from t_ids where k = $1 $$;
grant execute on function pg_temp.wsa(), pg_temp.wsb(), pg_temp.j(text) to anon, authenticated, service_role;

set role service_role;
insert into t_ids values ('runA', public.map_run_create(pg_temp.wsa(), 'a1010101-0000-0000-0000-000000000001', 'peinados', 'es', 'es-MX', 20, 50, 'fast', 'k-a10-1'));
insert into t_ids values ('runB', public.map_run_create(pg_temp.wsb(), 'b1010101-0000-0000-0000-000000000002', 'recetas', 'es', 'es-MX', 20, 50, 'fast', 'k-b10-1'));
reset role;

-- A: five candidates. p0..p3 are primaries with vectors, p4 is merged (vector kept on purpose: it must not appear as an edge).
-- p0=(1,0) p1=(0.9,0.4359) p2=(0,1) p3=(0.8,0.6)
insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, seq, status) values
  (pg_temp.wsa(), pg_temp.j('runA'), 'p0', 'p0', 'es', 'test', 0, 'primary'),
  (pg_temp.wsa(), pg_temp.j('runA'), 'p1', 'p1', 'es', 'test', 1, 'primary'),
  (pg_temp.wsa(), pg_temp.j('runA'), 'p2', 'p2', 'es', 'test', 2, 'primary'),
  (pg_temp.wsa(), pg_temp.j('runA'), 'p3', 'p3', 'es', 'test', 3, 'primary'),
  (pg_temp.wsa(), pg_temp.j('runA'), 'p4', 'p4', 'es', 'test', 4, 'merged'),
  (pg_temp.wsb(), pg_temp.j('runB'), 'q0', 'q0', 'es', 'test', 0, 'primary');
create function pg_temp.cid(raw text) returns uuid language sql as $$ select id from public.kw_candidates where kw_candidates.raw = $1 and workspace_id in (select ws from t_ws) $$;
grant execute on function pg_temp.cid(text) to anon, authenticated, service_role;

set role service_role;
select public.kw_set_embeddings(pg_temp.j('runA'), jsonb_build_array(
  jsonb_build_object('id', pg_temp.cid('p0'), 'embedding', to_jsonb((array[1, 0] || array_fill(0, array[1534])))),
  jsonb_build_object('id', pg_temp.cid('p1'), 'embedding', to_jsonb((array[0.9, 0.43589] || array_fill(0::numeric, array[1534])))),
  jsonb_build_object('id', pg_temp.cid('p2'), 'embedding', to_jsonb((array[0, 1] || array_fill(0, array[1534])))),
  jsonb_build_object('id', pg_temp.cid('p3'), 'embedding', to_jsonb((array[0.8, 0.6] || array_fill(0::numeric, array[1534])))),
  jsonb_build_object('id', pg_temp.cid('p4'), 'embedding', to_jsonb((array[1, 0] || array_fill(0, array[1534]))))));
reset role;

-- ===========================================================================
-- Registry
-- ===========================================================================
insert into t_results (who, test, actual, expected) values
  ('registry', 'the two new tasks have routes and each resolves to at least one priced model',
     (select count(*) from public.llm_routes where task in ('intent_classification', 'silo_naming'))::text || '/' ||
     ((select count(*) from public.llm_route_models('intent_classification')) > 0)::text || '/' ||
     ((select count(*) from public.llm_route_models('silo_naming')) > 0)::text, '2/true/true'),
  ('registry', 'cross-provider tasks used by S9 exist (map_audit, qa_cross_judge)',
     (select count(*) from public.llm_routes where task in ('map_audit', 'qa_cross_judge'))::text, '2');

-- ===========================================================================
-- Check constraints and column grants
-- ===========================================================================
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('constraint', 'unknown intent / funnel / out-of-range fit are refused (23514)',
     pg_temp.try(format($q$update public.kw_candidates set intent = 'browsing' where id = %L$q$, pg_temp.cid('p0'))) || '/' ||
     pg_temp.try(format($q$update public.kw_candidates set funnel = 'bofu' where id = %L$q$, pg_temp.cid('p0'))) || '/' ||
     pg_temp.try(format($q$update public.kw_candidates set pinterest_fit = 9 where id = %L$q$, pg_temp.cid('p0'))),
     'err:23514/err:23514/err:23514');
reset role;

-- ===========================================================================
-- kw_apply_classification
-- ===========================================================================
set role service_role;
select public.kw_apply_classification(pg_temp.j('runA'), jsonb_build_array(
  jsonb_build_object('id', pg_temp.cid('p0'), 'intent', 'informational', 'funnel', 'awareness', 'demand_tier', 4, 'pinterest_fit', 5, 'seasonality', 2, 'priority', 61.5, 'flags', jsonb_build_array('price_words'))));
select public.kw_apply_classification(pg_temp.j('runA'), jsonb_build_array(
  jsonb_build_object('id', pg_temp.cid('p0'), 'flags', jsonb_build_array('mixed_intent', 'price_words'))));
reset role;
insert into t_results (who, test, actual, expected) values
  ('classify', 'fields are stored and demand_source is always estimate',
     (select intent || '/' || funnel || '/' || demand_tier || '/' || demand_source || '/' || pinterest_fit || '/' || seasonality || '/' || priority from public.kw_candidates where id = pg_temp.cid('p0')),
     'informational/awareness/4/estimate/5/2/61.5'),
  ('classify', 'flags merge without duplicates and a later call without intent keeps the old intent',
     (select array_to_string(flags, ',') || '/' || intent from public.kw_candidates where id = pg_temp.cid('p0')), 'mixed_intent,price_words/informational'),
  ('classify', 'a row of another run is not touched',
     (select count(*)::text from public.kw_candidates where id = pg_temp.cid('q0') and intent is not null), '0');
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('classify', 'invalid payloads are refused (22023); a bad intent aborts the whole call (23514)',
     pg_temp.try($q$select public.kw_apply_classification(gen_random_uuid(), '{"a":1}'::jsonb)$q$) || '/' ||
     pg_temp.try(format($q$select public.kw_apply_classification(%L, jsonb_build_array(jsonb_build_object('id', %L, 'intent', 'browsing')))$q$, pg_temp.j('runA'), pg_temp.cid('p1'))),
     'err:22023/err:23514');
reset role;

-- ===========================================================================
-- kw_primary_edges
-- ===========================================================================
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('edges', 'min 0.5, k 2: 7 directed rows (p0:p1,p3  p1:p3,p0  p2:p3  p3:p1,p0); merged p4 is never an edge',
     (select count(*)::text from public.kw_primary_edges(pg_temp.j('runA'), 0.5, 2, 0, 100)), '7'),
  ('edges', 'k 1: each primary keeps only its best neighbour (4 rows) and p3''s best is p1 at ~0.98',
     (select count(*) || '/' || (select round(cosine::numeric, 2) from public.kw_primary_edges(pg_temp.j('runA'), 0.5, 1, 0, 100) where a = pg_temp.cid('p3'))
        from public.kw_primary_edges(pg_temp.j('runA'), 0.5, 1, 0, 100)), '4/0.98'),
  ('edges', 'paging walks the same ordered list: 3 + 3 + 1 rows, no overlap, none missing',
     (select count(*)::text from (
        select * from public.kw_primary_edges(pg_temp.j('runA'), 0.5, 2, 0, 3)
        union all select * from public.kw_primary_edges(pg_temp.j('runA'), 0.5, 2, 3, 3)
        union all select * from public.kw_primary_edges(pg_temp.j('runA'), 0.5, 2, 6, 3)) x), '7'),
  ('edges', 'the three pages are all distinct rows',
     (select count(distinct (a, b))::text from (
        select * from public.kw_primary_edges(pg_temp.j('runA'), 0.5, 2, 0, 3)
        union all select * from public.kw_primary_edges(pg_temp.j('runA'), 0.5, 2, 3, 3)
        union all select * from public.kw_primary_edges(pg_temp.j('runA'), 0.5, 2, 6, 3)) x), '7'),
  ('edges', 'min 0.95 leaves only the (p1,p3) pair in both directions',
     (select count(*)::text from public.kw_primary_edges(pg_temp.j('runA'), 0.95, 5, 0, 100)), '2'),
  ('edges', 'another run returns nothing; bad paging is refused (22023)',
     (select count(*)::text from public.kw_primary_edges(gen_random_uuid(), 0, 5, 0, 100)) || '/' ||
     pg_temp.try($q$select * from public.kw_primary_edges(gen_random_uuid(), 0.5, 0, 0, 10)$q$) || '/' ||
     pg_temp.try($q$select * from public.kw_primary_edges(gen_random_uuid(), 0.5, 5, 0, 5000)$q$),
     '0/err:22023/err:22023');
reset role;

-- ===========================================================================
-- Silos and plan items
-- ===========================================================================
insert into public.silos (workspace_id, project_id, map_run_id, name, position, size)
  select pg_temp.wsa(), project_id, id, 'Silo uno', 0, 2 from public.map_runs where id = pg_temp.j('runA');
insert into public.silos (workspace_id, project_id, map_run_id, name, position, size)
  select pg_temp.wsb(), project_id, id, 'Silo B', 0, 1 from public.map_runs where id = pg_temp.j('runB');
insert into t_ids select 'siloA', id from public.silos where name = 'Silo uno';
insert into t_ids select 'siloB', id from public.silos where name = 'Silo B';
insert into public.plan_items (workspace_id, project_id, map_run_id, silo_id, primary_kw_id, keyword, article_type, position)
  select pg_temp.wsa(), project_id, id, pg_temp.j('siloA'), pg_temp.cid('p0'), 'p0', 'A', 0 from public.map_runs where id = pg_temp.j('runA');
insert into public.plan_items (workspace_id, project_id, map_run_id, silo_id, primary_kw_id, keyword, article_type, position)
  select pg_temp.wsa(), project_id, id, pg_temp.j('siloA'), pg_temp.cid('p1'), 'p1', 'B', 1 from public.map_runs where id = pg_temp.j('runA');
insert into public.plan_items (workspace_id, project_id, map_run_id, silo_id, primary_kw_id, keyword, article_type, position)
  select pg_temp.wsb(), project_id, id, pg_temp.j('siloB'), pg_temp.cid('q0'), 'q0', 'A', 0 from public.map_runs where id = pg_temp.j('runB');
insert into t_ids select 'itemA0', id from public.plan_items where keyword = 'p0';
insert into t_ids select 'itemA1', id from public.plan_items where keyword = 'p1';
insert into t_ids select 'itemB0', id from public.plan_items where keyword = 'q0';
update public.silos set pillar_item_id = pg_temp.j('itemA0') where id = pg_temp.j('siloA');

insert into t_results (who, test, actual, expected) values
  ('items', 'defaults: status proposed, decision separate, 1500 words, empty variants / flags',
     (select status || '/' || decision || '/' || target_words || '/' || cardinality(variants) || '/' || cardinality(flags) from public.plan_items where id = pg_temp.j('itemA0')), 'proposed/separate/1500/0/0'),
  ('items', 'bad slug, bad type, duplicate primary are refused (23514 / 23514 / 23505)',
     pg_temp.try(format($q$update public.plan_items set slug = 'Bad Slug' where id = %L$q$, pg_temp.j('itemA0'))) || '/' ||
     pg_temp.try(format($q$update public.plan_items set article_type = 'C' where id = %L$q$, pg_temp.j('itemA0'))) || '/' ||
     pg_temp.try(format($q$insert into public.plan_items (workspace_id, project_id, map_run_id, primary_kw_id, keyword, article_type) select workspace_id, project_id, map_run_id, primary_kw_id, 'dup', 'A' from public.plan_items where id = %L$q$, pg_temp.j('itemA0'))),
     'err:23514/err:23514/err:23505');

set role service_role;
select public.plan_items_apply(pg_temp.j('runA'), jsonb_build_array(
  jsonb_build_object('id', pg_temp.j('itemA0'), 'title', 'Los 27 Mejores Peinados', 'slug', 'peinados-faciles',
                     'title_options', jsonb_build_array('Los 27 Mejores Peinados', '27 Peinados Faciles'),
                     'gloss', jsonb_build_object('en', 'easy hairstyles', 'bn', 'সহজ হেয়ারস্টাইল'),
                     'link_plan', jsonb_build_object('pillar', null, 'siblings', jsonb_build_array()), 'flags', jsonb_build_array('title_fallback')),
  jsonb_build_object('id', pg_temp.j('itemA1'), 'slug', 'plancha-pelo')));
reset role;
insert into t_results (who, test, actual, expected) values
  ('apply', 'titles, slug, gloss and flags are stored; a missing key keeps the old value',
     (select title || '/' || slug || '/' || jsonb_array_length(title_options) || '/' || (gloss ->> 'en') || '/' || array_to_string(flags, ',') from public.plan_items where id = pg_temp.j('itemA0')),
     'Los 27 Mejores Peinados/peinados-faciles/2/easy hairstyles/title_fallback'),
  ('apply', 'the second item only got its slug (title stays null, status stays proposed)',
     (select coalesce(title, '<null>') || '/' || slug || '/' || status from public.plan_items where id = pg_temp.j('itemA1')), '<null>/plancha-pelo/proposed');
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('apply', 'a duplicate slug inside one run is refused and the whole call changes nothing',
     pg_temp.try(format($q$select public.plan_items_apply(%L, jsonb_build_array(jsonb_build_object('id', %L, 'title', 'X title here', 'slug', 'peinados-faciles')))$q$, pg_temp.j('runA'), pg_temp.j('itemA1'))) || '/' ||
     (select coalesce(title, '<null>') from public.plan_items where id = pg_temp.j('itemA1')), 'err:23505/<null>'),
  ('apply', 'another run id cannot change these items; a non-array payload is refused (22023)',
     (select public.plan_items_apply(pg_temp.j('runB'), jsonb_build_array(jsonb_build_object('id', pg_temp.j('itemA0'), 'title', 'hijack title'))))::text || '/' ||
     pg_temp.try($q$select public.plan_items_apply(gen_random_uuid(), '{"a":1}'::jsonb)$q$), '0/err:22023');
reset role;
insert into t_results (who, test, actual, expected) values
  ('apply', 'item A0 kept its own title after the hijack attempt',
     (select title from public.plan_items where id = pg_temp.j('itemA0')), 'Los 27 Mejores Peinados');

-- ===========================================================================
-- Run stats, report, snapshot
-- ===========================================================================
set role service_role;
select public.map_run_merge_stats(pg_temp.j('runA'), '{"silos": 1, "primaries": 4}'::jsonb);
select public.map_run_merge_stats(pg_temp.j('runA'), '{"items": 2}'::jsonb);
select public.map_run_set_report(pg_temp.j('runA'), '{"verdict": "flag"}'::jsonb);
reset role;
insert into t_results (who, test, actual, expected) values
  ('stats', 'merge_stats adds keys without dropping the earlier ones; set_report stores the report',
     (select (stats ->> 'silos') || '/' || (stats ->> 'primaries') || '/' || (stats ->> 'items') || '/' || (report ->> 'verdict') from public.map_runs where id = pg_temp.j('runA')), '1/4/2/flag');

set role service_role;
select public.map_run_finish(pg_temp.j('runB'), 'canceled');
select public.map_run_merge_stats(pg_temp.j('runB'), '{"late": 1}'::jsonb);
select public.map_run_set_report(pg_temp.j('runB'), '{"verdict": "pass"}'::jsonb);
reset role;
insert into t_results (who, test, actual, expected) values
  ('stats', 'a finished run''s stats and report no longer change',
     (select coalesce(stats ->> 'late', '<none>') || '/' || coalesce(report ->> 'verdict', '<none>') from public.map_runs where id = pg_temp.j('runB')), '<none>/<none>');

-- a second run in A's project (inserted directly: map_run_create would need 20 more credits)
insert into public.map_runs (workspace_id, project_id, topic, language, locale, target_min, target_max)
  select workspace_id, project_id, topic, language, locale, 20, 50 from public.map_runs where id = pg_temp.j('runA');
insert into t_ids select 'runA2', id from public.map_runs where workspace_id = pg_temp.wsa() and id <> pg_temp.j('runA');

set role service_role;
create temp table t_snap (k text, v integer);
grant all on t_snap to service_role;
insert into t_snap values ('first',  public.map_snapshot_create(pg_temp.j('runA'),  '{"verdict":"flag"}'::jsonb));
insert into t_snap values ('again',  public.map_snapshot_create(pg_temp.j('runA'),  '{"verdict":"changed"}'::jsonb));
insert into t_snap values ('second', public.map_snapshot_create(pg_temp.j('runA2'), '{"verdict":"pass"}'::jsonb));
reset role;
insert into t_results (who, test, actual, expected) values
  ('snapshot', 'first = version 1, a retry returns the same version, the next run of the project = version 2',
     (select string_agg(k || '=' || v, ',' order by k) from t_snap), 'again=1,first=1,second=2'),
  ('snapshot', 'a retry does not add a row and does not overwrite the summary',
     (select count(*) || '/' || (select summary ->> 'verdict' from public.map_snapshots where map_run_id = pg_temp.j('runA')) from public.map_snapshots where project_id = (select project_id from public.map_runs where id = pg_temp.j('runA'))), '2/flag');
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('snapshot', 'unknown run -> PM004', pg_temp.try($q$select public.map_snapshot_create(gen_random_uuid(), '{}'::jsonb)$q$), 'err:PM004');
reset role;
insert into public.map_snapshots (workspace_id, project_id, map_run_id, version, summary)
  select pg_temp.wsb(), project_id, id, 1, '{}'::jsonb from public.map_runs where id = pg_temp.j('runB');

-- ===========================================================================
-- RLS as real client roles
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"a1010101-0000-0000-0000-000000000001","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'a1010101-0000-0000-0000-000000000001', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('A', 'sees own silo, 2 plan items, 2 snapshots',
     (select count(*) from public.silos) || '/' || (select count(*) from public.plan_items) || '/' || (select count(*) from public.map_snapshots), '1/2/2'),
  ('A', 'does not see B''s silo, items or snapshot',
     (select count(*) from public.silos where workspace_id = pg_temp.wsb()) || '/' || (select count(*) from public.plan_items where workspace_id = pg_temp.wsb()) || '/' || (select count(*) from public.map_snapshots where workspace_id = pg_temp.wsb()), '0/0/0'),
  ('A', 'cannot insert, update or delete in any of the three tables',
     pg_temp.try(format($q$insert into public.silos (workspace_id, project_id, map_run_id, name) select workspace_id, project_id, id, 'x' from public.map_runs where id = %L$q$, pg_temp.j('runA'))) || '/' ||
     pg_temp.try(format($q$update public.plan_items set title = 'mine' where id = %L$q$, pg_temp.j('itemA0'))) || '/' ||
     pg_temp.try($q$delete from public.map_snapshots$q$),
     'err:42501/err:42501/err:42501'),
  ('A', 'reads the new S5 columns but still not the embedding',
     pg_temp.try(format($q$select pinterest_fit, seasonality, intent, funnel from public.kw_candidates where id = %L$q$, pg_temp.cid('p0'))) || '/' ||
     pg_temp.try($q$select embedding from public.kw_candidates$q$), 'ok/err:42501'),
  ('A', 'cannot call any of the server functions',
     pg_temp.try($q$select public.kw_apply_classification(gen_random_uuid(), '[]'::jsonb)$q$) || '/' ||
     pg_temp.try($q$select * from public.kw_primary_edges(gen_random_uuid(), 0.5, 5, 0, 10)$q$) || '/' ||
     pg_temp.try($q$select public.plan_items_apply(gen_random_uuid(), '[]'::jsonb)$q$) || '/' ||
     pg_temp.try($q$select public.map_plan_reset(gen_random_uuid())$q$) || '/' ||
     pg_temp.try($q$select public.map_snapshot_create(gen_random_uuid(), '{}'::jsonb)$q$) || '/' ||
     pg_temp.try($q$select public.map_run_merge_stats(gen_random_uuid(), '{}'::jsonb)$q$) || '/' ||
     pg_temp.try($q$select public.map_run_set_report(gen_random_uuid(), '{}'::jsonb)$q$),
     'err:42501/err:42501/err:42501/err:42501/err:42501/err:42501/err:42501');
reset role;
select set_config('request.jwt.claims', '{}', false);

set role anon;
insert into t_results (who, test, actual, expected) values
  ('anon', 'sees nothing and cannot read the tables',
     pg_temp.try($q$select count(*) from public.silos$q$) || '/' || pg_temp.try($q$select count(*) from public.plan_items$q$) || '/' || pg_temp.try($q$select count(*) from public.map_snapshots$q$),
     'err:42501/err:42501/err:42501');
reset role;

-- ===========================================================================
-- map_plan_reset (idempotent S6), pillar FK, cascades
-- ===========================================================================
delete from public.plan_items where id = pg_temp.j('itemA1');
insert into t_results (who, test, actual, expected) values
  ('fk', 'deleting a plan item leaves its silo (the pillar link is cleared only when the pillar itself goes)',
     (select count(*) from public.silos where id = pg_temp.j('siloA'))::text || '/' || (select (pillar_item_id is not null)::text from public.silos where id = pg_temp.j('siloA')), '1/true');
delete from public.plan_items where id = pg_temp.j('itemA0');
insert into t_results (who, test, actual, expected) values
  ('fk', 'deleting the pillar item clears silos.pillar_item_id',
     (select (pillar_item_id is null)::text from public.silos where id = pg_temp.j('siloA')), 'true');
insert into public.plan_items (workspace_id, project_id, map_run_id, silo_id, primary_kw_id, keyword, article_type)
  select pg_temp.wsa(), project_id, id, pg_temp.j('siloA'), pg_temp.cid('p2'), 'p2', 'A' from public.map_runs where id = pg_temp.j('runA');
set role service_role;
select public.map_plan_reset(pg_temp.j('runA'));
reset role;
insert into t_results (who, test, actual, expected) values
  ('reset', 'map_plan_reset removes the run''s items and silos and nothing of B',
     (select count(*) from public.plan_items where map_run_id = pg_temp.j('runA')) || '/' || (select count(*) from public.silos where map_run_id = pg_temp.j('runA')) || '/' ||
     (select count(*) from public.plan_items where map_run_id = pg_temp.j('runB')) || '/' || (select count(*) from public.silos where map_run_id = pg_temp.j('runB')), '0/0/1/1'),
  ('reset', 'the candidates survive the reset (it only rebuilds the plan)',
     (select count(*)::text from public.kw_candidates where map_run_id = pg_temp.j('runA')), '5');

delete from public.map_runs where id = pg_temp.j('runB');
insert into t_results (who, test, actual, expected) values
  ('cascade', 'deleting a run removes its silos and items; the snapshot stays but loses its run link',
     (select count(*) from public.silos where id = pg_temp.j('siloB')) || '/' || (select count(*) from public.plan_items where id = pg_temp.j('itemB0')) || '/' ||
     (select count(*) from public.map_snapshots where workspace_id = pg_temp.wsb() and map_run_id is null), '0/0/1');

-- ===========================================================================
-- Cleanup
-- ===========================================================================
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a1010101-0000-0000-0000-000000000001','b1010101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from public.jobs where payload ->> 'mapRunId' in (select id::text from public.map_runs where workspace_id in (select ws from t_ws));
delete from auth.users where id in ('a1010101-0000-0000-0000-000000000001','b1010101-0000-0000-0000-000000000002');

insert into t_results (who, test, actual, expected)
select 'cleanup', 'test users, workspaces, runs and snapshots are gone',
       (select count(*) from auth.users where email like '%10@example.test') || '/' ||
       (select count(*) from public.map_runs where id in (select v from t_ids where k like 'run%')) || '/' ||
       (select count(*) from public.map_snapshots where workspace_id in (select ws from t_ws)), '0/0/0';

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
