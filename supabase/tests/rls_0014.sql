-- rls_0014.sql — tests for migration 0014 (merge / split / move plan items by hand: gates, structure, link plans)
--
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0008-0014 are applied). Safe to re-run.
-- Creates two throw-away users (A owns the runs, B is a stranger) and removes everything at the end.
-- EXPECTED OUTPUT: every row pass = true; last row  ALL CHECKS | <N> of <N> passed | (blank) | (blank) | true

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a1410101-0000-0000-0000-000000000001','b1410101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a1410101-0000-0000-0000-000000000001','b1410101-0000-0000-0000-000000000002');

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('a1410101-0000-0000-0000-000000000001','authenticated','authenticated','a14@example.test', now()),
  ('b1410101-0000-0000-0000-000000000002','authenticated','authenticated','b14@example.test', now());
create temp table t_ws as select owner_id as uid, id as ws from public.workspaces
  where owner_id in ('a1410101-0000-0000-0000-000000000001','b1410101-0000-0000-0000-000000000002');
grant select on t_ws to anon, authenticated, service_role;
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to anon, authenticated, service_role;
create function pg_temp.wsa() returns uuid language sql as $$ select ws from t_ws where uid = 'a1410101-0000-0000-0000-000000000001' $$;
create function pg_temp.j(k text) returns uuid language sql as $$ select v from t_ids where k = $1 $$;
grant execute on function pg_temp.wsa(), pg_temp.j(text) to anon, authenticated, service_role;
create function pg_temp.ua() returns uuid language sql as $$ select 'a1410101-0000-0000-0000-000000000001'::uuid $$;
create function pg_temp.ub() returns uuid language sql as $$ select 'b1410101-0000-0000-0000-000000000002'::uuid $$;
grant execute on function pg_temp.ua(), pg_temp.ub() to anon, authenticated, service_role;

set role service_role;
select public.credit_adjust(pg_temp.wsa(), 100, 'test_grant', 'test-0014:' || pg_temp.wsa()::text, 'test', 'x');
insert into t_ids values ('ok',   public.map_run_create(pg_temp.wsa(), pg_temp.ua(), 'peinados', 'es', 'es-MX', 20, 50, 'fast', 'k-a14-ok'));
insert into t_ids values ('live', public.map_run_create(pg_temp.wsa(), pg_temp.ua(), 'tatuajes', 'es', 'es-MX', 20, 50, 'fast', 'k-a14-live'));
reset role;

-- run ok: 8 items; silo s1 = i1..i4 (pillar i1), silo s2 = i5..i8 (pillar i5); i2 has variant 'v2a', i4 has variant 'ghost'
-- (no keyword candidate behind it); candidate 'v2a' exists as a merged one. Run live: one silo, two items.
insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, seq, status)
select pg_temp.wsa(), pg_temp.j('ok'), 'kw' || g, 'kw' || g, 'es', 'test', g, 'primary' from generate_series(1, 8) g;
insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, seq, status, merged_into)
select pg_temp.wsa(), pg_temp.j('ok'), 'v2a', 'v2a', 'es', 'test', 20, 'merged', id from public.kw_candidates where map_run_id = pg_temp.j('ok') and raw = 'kw2';
insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, seq, status)
select pg_temp.wsa(), pg_temp.j('live'), 'lw' || g, 'lw' || g, 'es', 'test', g, 'primary' from generate_series(1, 2) g;

insert into public.silos (workspace_id, project_id, map_run_id, name, position)
select pg_temp.wsa(), project_id, id, 'silo ' || s, s from public.map_runs, generate_series(1, 2) s where id = pg_temp.j('ok');
insert into public.silos (workspace_id, project_id, map_run_id, name, position)
select pg_temp.wsa(), project_id, id, 'live silo', 1 from public.map_runs where id = pg_temp.j('live');
insert into t_ids select 's' || position, id from public.silos where map_run_id = pg_temp.j('ok');
insert into t_ids select 'sl', id from public.silos where map_run_id = pg_temp.j('live');

insert into public.plan_items (workspace_id, project_id, map_run_id, silo_id, primary_kw_id, keyword, article_type, position, variants)
select pg_temp.wsa(), r.project_id, r.id, case when c.seq <= 4 then pg_temp.j('s1') else pg_temp.j('s2') end, c.id, c.raw, 'A', c.seq,
       case c.raw when 'kw2' then array['v2a'] when 'kw4' then array['ghost'] else '{}'::text[] end
from public.map_runs r join public.kw_candidates c on c.map_run_id = r.id where r.id = pg_temp.j('ok') and c.status = 'primary';
insert into public.plan_items (workspace_id, project_id, map_run_id, silo_id, primary_kw_id, keyword, article_type, position)
select pg_temp.wsa(), r.project_id, r.id, pg_temp.j('sl'), c.id, c.raw, 'A', c.seq
from public.map_runs r join public.kw_candidates c on c.map_run_id = r.id where r.id = pg_temp.j('live');
insert into t_ids select 'i' || position, id from public.plan_items where map_run_id = pg_temp.j('ok');
insert into t_ids select 'l' || position, id from public.plan_items where map_run_id = pg_temp.j('live');
update public.silos set pillar_item_id = pg_temp.j('i1') where id = pg_temp.j('s1');
update public.silos set pillar_item_id = pg_temp.j('i5') where id = pg_temp.j('s2');
update public.silos set pillar_item_id = pg_temp.j('l1') where id = pg_temp.j('sl');
select public.plan_links_fix(pg_temp.j('ok'));
select public.plan_links_fix(pg_temp.j('live'));

set role service_role;
select public.map_run_set_report(pg_temp.j('ok'), '{"verdict":"pass","checks":[]}'::jsonb);
select public.map_run_finish(pg_temp.j('ok'), 'succeeded');
reset role;

create function pg_temp.siz(s text) returns text language sql as $$ select size::text from public.silos where id = pg_temp.j($1) $$;
create function pg_temp.kids(s text) returns text language sql as $$
  select jsonb_array_length(link_plan -> 'children')::text from public.plan_items where id = (select pillar_item_id from public.silos where id = pg_temp.j($1)) $$;
grant execute on function pg_temp.siz(text), pg_temp.kids(text) to anon, authenticated, service_role;

-- start state
insert into t_results (who, test, actual, expected) values
  ('setup', 'silo sizes 4/4; each pillar links 3 children', pg_temp.siz('s1') || '/' || pg_temp.siz('s2') || '/' || pg_temp.kids('s1') || '/' || pg_temp.kids('s2'), '4/4/3/3');

-- ===========================================================================
-- Merge: i3 into i2
-- ===========================================================================
set role service_role;
create temp table t_calls (k text primary key, v text);
grant all on t_calls to anon, authenticated, service_role;
insert into t_calls values ('merge', public.plan_item_merge(pg_temp.ua(), pg_temp.j('ok'), pg_temp.j('i2'), pg_temp.j('i3'))::text);
reset role;
insert into t_results (who, test, actual, expected) values
  ('merge', 'i3 disappears; its keyword becomes a variant of i2 next to v2a; flagged manual_merge',
     (select count(*)::text from public.plan_items where id = pg_temp.j('i3')) || '/' ||
     (select array_to_string(variants, ',') from public.plan_items where id = pg_temp.j('i2')) || '/' ||
     (select (flags @> array['manual_merge'])::text from public.plan_items where id = pg_temp.j('i2')), '0/v2a,kw3/true'),
  ('merge', 'silo 1 shrinks to 3 and its pillar now links 2 children; the dropped candidate is marked merged into kw2',
     pg_temp.siz('s1') || '/' || pg_temp.kids('s1') || '/' ||
     (select c.status || ':' || (c.merged_into = (select primary_kw_id from public.plan_items where id = pg_temp.j('i2')))::text from public.kw_candidates c where c.map_run_id = pg_temp.j('ok') and c.raw = 'kw3'), '3/2/merged:true'),
  ('merge', 'no link plan of the run still mentions the dropped item',
     (select count(*)::text from public.plan_items where map_run_id = pg_temp.j('ok') and link_plan::text like '%' || pg_temp.j('i3')::text || '%'), '0');

-- ===========================================================================
-- Split: variant v2a out of i2
-- ===========================================================================
set role service_role;
insert into t_calls values ('split', public.plan_item_split(pg_temp.ua(), pg_temp.j('ok'), pg_temp.j('i2'), 'V2A')::text);
reset role;
insert into t_results (who, test, actual, expected) values
  ('split', 'v2a becomes its own draft item in silo 1, flagged needs_title, without a title',
     (select count(*)::text || ':' || coalesce(max(title), 'none') || ':' || (max(silo_id::text) = pg_temp.j('s1')::text)::text || ':' || (bool_and(flags @> array['manual_split','needs_title']))::text
        from public.plan_items where map_run_id = pg_temp.j('ok') and keyword = 'v2a'), '1:none:true:true'),
  ('split', 'i2 keeps only kw3; silo 1 is back to 4 items; the pillar links 3 children; the candidate is primary again',
     (select array_to_string(variants, ',') from public.plan_items where id = pg_temp.j('i2')) || '/' || pg_temp.siz('s1') || '/' || pg_temp.kids('s1') || '/' ||
     (select status from public.kw_candidates where map_run_id = pg_temp.j('ok') and raw = 'v2a'), 'kw3/4/3/primary'),
  ('split', 'the new item links to the pillar and has at least 2 siblings',
     (select (link_plan ->> 'pillar' = pg_temp.j('i1')::text)::text || '/' || (jsonb_array_length(link_plan -> 'siblings') >= 2)::text
        from public.plan_items where map_run_id = pg_temp.j('ok') and keyword = 'v2a'), 'true/true');

-- ===========================================================================
-- Move: i4 to silo 2
-- ===========================================================================
set role service_role;
insert into t_calls values ('move', public.plan_items_move(pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i4')], pg_temp.j('s2'))::text);
insert into t_calls values ('move_again', public.plan_items_move(pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i4')], pg_temp.j('s2'))::text);
reset role;
insert into t_results (who, test, actual, expected) values
  ('move', 'one item moved, a replay moves 0; sizes 3 and 5; pillar 1 links 2, pillar 2 links 4',
     (select v from t_calls where k = 'move') || '/' || (select v from t_calls where k = 'move_again') || '/' || pg_temp.siz('s1') || '/' || pg_temp.siz('s2') || '/' || pg_temp.kids('s1') || '/' || pg_temp.kids('s2'), '1/0/3/5/2/4'),
  ('move', 'i4 now points at pillar 2, has 2+ siblings, none from silo 1; flagged manual_move',
     (select (link_plan ->> 'pillar' = pg_temp.j('i5')::text)::text || '/' || (jsonb_array_length(link_plan -> 'siblings') >= 2)::text || '/' ||
             (select count(*)::text from jsonb_array_elements_text(link_plan -> 'siblings') s(x) join public.plan_items o on o.id::text = s.x where o.silo_id <> pg_temp.j('s2')) || '/' || (flags @> array['manual_move'])::text
        from public.plan_items where id = pg_temp.j('i4')), 'true/true/0/true'),
  ('move', 'every item of silo 1 and 2 points at the right pillar and no item lists itself or a foreign silo as sibling',
     (select count(*)::text from public.plan_items p join public.silos s on s.id = p.silo_id
        where p.map_run_id = pg_temp.j('ok') and (
          (s.pillar_item_id <> p.id and p.link_plan ->> 'pillar' is distinct from s.pillar_item_id::text)
          or exists (select 1 from jsonb_array_elements_text(p.link_plan -> 'siblings') x(id) join public.plan_items o on o.id::text = x.id where o.silo_id <> p.silo_id or o.id = p.id))), '0');

-- ===========================================================================
-- Gates
-- ===========================================================================
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('gate', 'a pillar cannot be dropped, split or moved (PM003)',
     pg_temp.try(format($q$select public.plan_item_merge(%L, %L, %L, %L)$q$, pg_temp.ua(), pg_temp.j('ok'), pg_temp.j('i6'), pg_temp.j('i5'))) || '/' ||
     pg_temp.try(format($q$select public.plan_item_split(%L, %L, %L, 'x')$q$, pg_temp.ua(), pg_temp.j('ok'), pg_temp.j('i1'))) || '/' ||
     pg_temp.try(format($q$select public.plan_items_move(%L, %L, %L, %L)$q$, pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i1')], pg_temp.j('s2'))), 'err:PM003/err:PM003/err:PM003'),
  ('gate', 'merging an item into itself or a missing item; unknown variant; variant without a candidate; empty / invalid move',
     pg_temp.try(format($q$select public.plan_item_merge(%L, %L, %L, %L)$q$, pg_temp.ua(), pg_temp.j('ok'), pg_temp.j('i6'), pg_temp.j('i6'))) || '/' ||
     pg_temp.try(format($q$select public.plan_item_merge(%L, %L, %L, %L)$q$, pg_temp.ua(), pg_temp.j('ok'), pg_temp.j('i6'), gen_random_uuid())) || '/' ||
     pg_temp.try(format($q$select public.plan_item_split(%L, %L, %L, 'nope')$q$, pg_temp.ua(), pg_temp.j('ok'), pg_temp.j('i2'))) || '/' ||
     pg_temp.try(format($q$select public.plan_item_split(%L, %L, %L, 'ghost')$q$, pg_temp.ua(), pg_temp.j('ok'), pg_temp.j('i4'))) || '/' ||
     pg_temp.try(format($q$select public.plan_items_move(%L, %L, '{}', %L)$q$, pg_temp.ua(), pg_temp.j('ok'), pg_temp.j('s1'))),
     'err:22023/err:PM004/err:PM004/err:PM004/err:22023'),
  ('gate', 'a silo of another run is not found (PM004)',
     pg_temp.try(format($q$select public.plan_items_move(%L, %L, %L, %L)$q$, pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i6')], pg_temp.j('sl'))), 'err:PM004'),
  ('gate', 'a stranger is refused (42501) for all three functions',
     pg_temp.try(format($q$select public.plan_item_merge(%L, %L, %L, %L)$q$, pg_temp.ub(), pg_temp.j('ok'), pg_temp.j('i6'), pg_temp.j('i7'))) || '/' ||
     pg_temp.try(format($q$select public.plan_item_split(%L, %L, %L, 'x')$q$, pg_temp.ub(), pg_temp.j('ok'), pg_temp.j('i2'))) || '/' ||
     pg_temp.try(format($q$select public.plan_items_move(%L, %L, %L, %L)$q$, pg_temp.ub(), pg_temp.j('ok'), array[pg_temp.j('i6')], pg_temp.j('s1'))), 'err:42501/err:42501/err:42501'),
  ('gate', 'a run that is not finished cannot be edited (PM003)',
     pg_temp.try(format($q$select public.plan_item_merge(%L, %L, %L, %L)$q$, pg_temp.ua(), pg_temp.j('live'), pg_temp.j('l1'), pg_temp.j('l2'))), 'err:PM003'),
  ('gate', 'an unknown run is PM004',
     pg_temp.try(format($q$select public.plan_items_move(%L, gen_random_uuid(), %L, %L)$q$, pg_temp.ua(), array[pg_temp.j('i6')], pg_temp.j('s1'))), 'err:PM004');
-- approved items are frozen
select public.plan_items_set_status(pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i6')], 'approved');
insert into t_results (who, test, actual, expected) values
  ('gate', 'an approved item cannot be merged (either side), split or moved (PM003); back to draft unlocks it',
     pg_temp.try(format($q$select public.plan_item_merge(%L, %L, %L, %L)$q$, pg_temp.ua(), pg_temp.j('ok'), pg_temp.j('i6'), pg_temp.j('i7'))) || '/' ||
     pg_temp.try(format($q$select public.plan_item_merge(%L, %L, %L, %L)$q$, pg_temp.ua(), pg_temp.j('ok'), pg_temp.j('i7'), pg_temp.j('i6'))) || '/' ||
     pg_temp.try(format($q$select public.plan_items_move(%L, %L, %L, %L)$q$, pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i6')], pg_temp.j('s1'))), 'err:PM003/err:PM003/err:PM003');
select public.plan_items_set_status(pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i6')], 'draft');
insert into t_results (who, test, actual, expected) values
  ('gate', 'after back to draft the same move works', public.plan_items_move(pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i6')], pg_temp.j('s1'))::text, '1');
reset role;
insert into t_results (who, test, actual, expected) values
  ('gate', 'failed calls changed nothing: 8 items remain in total (8 - 1 merged + 1 split)',
     (select count(*)::text from public.plan_items where map_run_id = pg_temp.j('ok')), '8');

-- authenticated users cannot call the functions
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('privilege', 'authenticated cannot execute merge / split / move / the internal helpers',
     pg_temp.try(format($q$select public.plan_item_merge(%L, %L, %L, %L)$q$, pg_temp.ua(), pg_temp.j('ok'), pg_temp.j('i6'), pg_temp.j('i7'))) || '/' ||
     pg_temp.try(format($q$select public.plan_item_split(%L, %L, %L, 'x')$q$, pg_temp.ua(), pg_temp.j('ok'), pg_temp.j('i2'))) || '/' ||
     pg_temp.try(format($q$select public.plan_items_move(%L, %L, %L, %L)$q$, pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i6')], pg_temp.j('s1'))) || '/' ||
     pg_temp.try(format($q$select public.plan_links_fix(%L)$q$, pg_temp.j('ok'))) || '/' ||
     pg_temp.try(format($q$select public.plan_edit_guard(%L, %L)$q$, pg_temp.ua(), pg_temp.j('ok'))),
     'err:42501/err:42501/err:42501/err:42501/err:42501');
reset role;

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a1410101-0000-0000-0000-000000000001','b1410101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a1410101-0000-0000-0000-000000000001','b1410101-0000-0000-0000-000000000002');

select n, who, test, actual, expected, (actual = expected) as pass from t_results
union all
select 9999, 'ALL CHECKS', (select count(*) filter (where actual = expected) from t_results)::text || ' of ' || (select count(*) from t_results)::text || ' passed', '', '',
       (select bool_and(actual = expected) from t_results)
order by 1;
