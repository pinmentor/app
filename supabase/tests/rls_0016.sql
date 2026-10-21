-- rls_0014.sql — tests for migration 0014 (merge / split / move plan items by hand: gates, structure, link plans)
-- rls_0016.sql — tests for migration 0016 (batches: create, cancel, remove items, gates, RLS, constraints)
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0008-0016 are applied). Safe to re-run.
-- Creates two throw-away users (A owns the runs, B is a stranger) and removes everything at the end.
-- EXPECTED OUTPUT: every row pass = true; last row  ALL CHECKS | <N> of <N> passed | (blank) | (blank) | true

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a1610101-0000-0000-0000-000000000001','b1610101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a1610101-0000-0000-0000-000000000001','b1610101-0000-0000-0000-000000000002');

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('a1610101-0000-0000-0000-000000000001','authenticated','authenticated','a16@example.test', now()),
  ('b1610101-0000-0000-0000-000000000002','authenticated','authenticated','b16@example.test', now());
create temp table t_ws as select owner_id as uid, id as ws from public.workspaces
  where owner_id in ('a1610101-0000-0000-0000-000000000001','b1610101-0000-0000-0000-000000000002');
grant select on t_ws to anon, authenticated, service_role;
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to anon, authenticated, service_role;
create function pg_temp.wsa() returns uuid language sql as $$ select ws from t_ws where uid = 'a1610101-0000-0000-0000-000000000001' $$;
create function pg_temp.j(k text) returns uuid language sql as $$ select v from t_ids where k = $1 $$;
grant execute on function pg_temp.wsa(), pg_temp.j(text) to anon, authenticated, service_role;
create function pg_temp.ua() returns uuid language sql as $$ select 'a1610101-0000-0000-0000-000000000001'::uuid $$;
create function pg_temp.ub() returns uuid language sql as $$ select 'b1610101-0000-0000-0000-000000000002'::uuid $$;
grant execute on function pg_temp.ua(), pg_temp.ub() to anon, authenticated, service_role;

set role service_role;
select public.credit_adjust(pg_temp.wsa(), 100, 'test_grant', 'test-0016:' || pg_temp.wsa()::text, 'test', 'x');
insert into t_ids values ('ok',   public.map_run_create(pg_temp.wsa(), pg_temp.ua(), 'peinados', 'es', 'es-MX', 20, 50, 'fast', 'k-a16-ok'));
insert into t_ids values ('live', public.map_run_create(pg_temp.wsa(), pg_temp.ua(), 'tatuajes', 'es', 'es-MX', 20, 50, 'fast', 'k-a16-live'));
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

create temp table t_calls (k text primary key, v text);
grant all on t_calls to anon, authenticated, service_role;
create function pg_temp.b(k text) returns uuid language sql as $$ select v::uuid from t_calls where k = $1 $$;
create function pg_temp.arr(k text, i integer) returns uuid language sql as $$ select (v::uuid[])[i] from t_calls where k = $1 $$;
grant execute on function pg_temp.b(text), pg_temp.arr(text, integer) to anon, authenticated, service_role;
create function pg_temp.st(k text) returns text language sql as $$ select status || ':' || coalesce(batch_id::text, '-') from public.plan_items where id = pg_temp.j($1) $$;
create function pg_temp.cnt(st text) returns text language sql as $$ select count(*)::text from public.plan_items where map_run_id = pg_temp.j('ok') and status = $1 $$;
grant execute on function pg_temp.st(text), pg_temp.cnt(text) to anon, authenticated, service_role;

-- proposed items: nothing can be batched yet; approve all 8 (and one item of the unfinished run is approved by hand)
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('gate', 'proposed items cannot go into a batch (PM003)',
     pg_temp.try(format($q$select public.batches_create(%L, %L, %L::jsonb, 'manual')$q$, pg_temp.ua(), pg_temp.j('ok'),
       jsonb_build_array(jsonb_build_object('name', 'x', 'item_ids', jsonb_build_array(pg_temp.j('i1')))))), 'err:PM003');
select public.plan_items_set_status(pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i1'),pg_temp.j('i2'),pg_temp.j('i3'),pg_temp.j('i4'),pg_temp.j('i5'),pg_temp.j('i6'),pg_temp.j('i7'),pg_temp.j('i8')], 'approved');
reset role;
update public.plan_items set status = 'approved' where id = pg_temp.j('l1');

-- ===========================================================================
-- Create: two auto batches inside silo 1, one manual batch that mixes silos
-- ===========================================================================
set role service_role;
insert into t_calls values ('auto', public.batches_create(pg_temp.ua(), pg_temp.j('ok'), jsonb_build_array(
  jsonb_build_object('name', 'silo 1 · batch 1', 'item_ids', jsonb_build_array(pg_temp.j('i1'), pg_temp.j('i2'))),
  jsonb_build_object('name', '  silo 1 · batch 2  ', 'item_ids', jsonb_build_array(pg_temp.j('i3')))), 'auto')::text);
insert into t_calls values ('man', public.batches_create(pg_temp.ua(), pg_temp.j('ok'), jsonb_build_array(
  jsonb_build_object('name', 'my mix', 'item_ids', jsonb_build_array(pg_temp.j('i4'), pg_temp.j('i5')))), 'manual')::text);
reset role;
insert into t_calls values ('b1', pg_temp.arr('auto', 1)::text), ('b2', pg_temp.arr('auto', 2)::text), ('b3', pg_temp.arr('man', 1)::text);
insert into t_results (who, test, actual, expected) values
  ('create', 'two auto batches + one manual: names trimmed, origin, status planned, positions 1,2,3',
     (select string_agg(name || '/' || origin || '/' || status || '/' || position, ';' order by position) from public.batches where map_run_id = pg_temp.j('ok')),
     'silo 1 · batch 1/auto/planned/1;silo 1 · batch 2/auto/planned/2;my mix/manual/planned/3'),
  ('create', 'a batch inside one silo gets that silo; a mixed manual batch gets none',
     (select (silo_id = pg_temp.j('s1'))::text from public.batches where id = pg_temp.b('b1')) || '/' ||
     (select (silo_id = pg_temp.j('s1'))::text from public.batches where id = pg_temp.b('b2')) || '/' ||
     (select coalesce(silo_id::text, 'none') from public.batches where id = pg_temp.b('b3')), 'true/true/none'),
  ('create', 'batched items are in_batch with their batch_id; the others stay approved (3 left)',
     (pg_temp.st('i1') = 'in_batch:' || pg_temp.b('b1'))::text || '/' || (pg_temp.st('i3') = 'in_batch:' || pg_temp.b('b2'))::text || '/' ||
     (pg_temp.st('i5') = 'in_batch:' || pg_temp.b('b3'))::text || '/' || pg_temp.cnt('in_batch') || '/' || pg_temp.cnt('approved'), 'true/true/true/5/3'),
  ('create', 'workspace and project of a batch come from the run; no credit is spent (balance unchanged after the run price)',
     (select (b.workspace_id = r.workspace_id and b.project_id = r.project_id)::text from public.batches b join public.map_runs r on r.id = b.map_run_id where b.id = pg_temp.b('b1')) || '/' ||
     (select count(*)::text from public.credit_ledger where workspace_id = pg_temp.wsa() and reason like '%batch%'), 'true/0');

-- ===========================================================================
-- Gates of create
-- ===========================================================================
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('gate', 'replaying a create fails: the items are no longer approved (PM003)',
     pg_temp.try(format($q$select public.batches_create(%L, %L, %L::jsonb, 'auto')$q$, pg_temp.ua(), pg_temp.j('ok'),
       jsonb_build_array(jsonb_build_object('name', 'again', 'item_ids', jsonb_build_array(pg_temp.j('i1')))))), 'err:PM003'),
  ('gate', 'an item of another run is PM004; an approved + a foreign item together create nothing',
     pg_temp.try(format($q$select public.batches_create(%L, %L, %L::jsonb, 'auto')$q$, pg_temp.ua(), pg_temp.j('ok'),
       jsonb_build_array(jsonb_build_object('name', 'x', 'item_ids', jsonb_build_array(pg_temp.j('i6'), pg_temp.j('l1')))))) || '/' ||
     (select count(*)::text from public.batches where map_run_id = pg_temp.j('ok')), 'err:PM004/3'),
  ('gate', 'bad input is 22023: empty name, no items, same item twice, one item in two batches, 101 items, bad origin, not an array, bad uuid',
     pg_temp.try(format($q$select public.batches_create(%L, %L, %L::jsonb, 'auto')$q$, pg_temp.ua(), pg_temp.j('ok'), jsonb_build_array(jsonb_build_object('name', '  ', 'item_ids', jsonb_build_array(pg_temp.j('i6')))))) || '/' ||
     pg_temp.try(format($q$select public.batches_create(%L, %L, %L::jsonb, 'auto')$q$, pg_temp.ua(), pg_temp.j('ok'), jsonb_build_array(jsonb_build_object('name', 'x', 'item_ids', jsonb_build_array())))) || '/' ||
     pg_temp.try(format($q$select public.batches_create(%L, %L, %L::jsonb, 'auto')$q$, pg_temp.ua(), pg_temp.j('ok'), jsonb_build_array(jsonb_build_object('name', 'x', 'item_ids', jsonb_build_array(pg_temp.j('i6'), pg_temp.j('i6')))))) || '/' ||
     pg_temp.try(format($q$select public.batches_create(%L, %L, %L::jsonb, 'auto')$q$, pg_temp.ua(), pg_temp.j('ok'), jsonb_build_array(
       jsonb_build_object('name', 'x', 'item_ids', jsonb_build_array(pg_temp.j('i6'))), jsonb_build_object('name', 'y', 'item_ids', jsonb_build_array(pg_temp.j('i6')))))) || '/' ||
     pg_temp.try(format($q$select public.batches_create(%L, %L, %L::jsonb, 'auto')$q$, pg_temp.ua(), pg_temp.j('ok'), jsonb_build_array(jsonb_build_object('name', 'x', 'item_ids', (select jsonb_agg(gen_random_uuid()) from generate_series(1, 101)))))) || '/' ||
     pg_temp.try(format($q$select public.batches_create(%L, %L, %L::jsonb, 'weird')$q$, pg_temp.ua(), pg_temp.j('ok'), jsonb_build_array(jsonb_build_object('name', 'x', 'item_ids', jsonb_build_array(pg_temp.j('i6')))))) || '/' ||
     pg_temp.try(format($q$select public.batches_create(%L, %L, '{"a":1}'::jsonb, 'auto')$q$, pg_temp.ua(), pg_temp.j('ok'))) || '/' ||
     pg_temp.try(format($q$select public.batches_create(%L, %L, '[{"name":"x","item_ids":["nope"]}]'::jsonb, 'auto')$q$, pg_temp.ua(), pg_temp.j('ok'))),
     'err:22023/err:22023/err:22023/err:22023/err:22023/err:22023/err:22023/err:22023'),
  ('gate', 'a stranger (42501), an unfinished run (PM003), an unknown run (PM004)',
     pg_temp.try(format($q$select public.batches_create(%L, %L, %L::jsonb, 'auto')$q$, pg_temp.ub(), pg_temp.j('ok'), jsonb_build_array(jsonb_build_object('name', 'x', 'item_ids', jsonb_build_array(pg_temp.j('i6')))))) || '/' ||
     pg_temp.try(format($q$select public.batches_create(%L, %L, %L::jsonb, 'auto')$q$, pg_temp.ua(), pg_temp.j('live'), jsonb_build_array(jsonb_build_object('name', 'x', 'item_ids', jsonb_build_array(pg_temp.j('l1')))))) || '/' ||
     pg_temp.try(format($q$select public.batches_create(%L, gen_random_uuid(), %L::jsonb, 'auto')$q$, pg_temp.ua(), jsonb_build_array(jsonb_build_object('name', 'x', 'item_ids', jsonb_build_array(pg_temp.j('i6')))))),
     'err:42501/err:PM003/err:PM004');
reset role;
insert into t_results (who, test, actual, expected) values
  ('gate', 'every failed call changed nothing: still 3 batches, 5 in_batch, 3 approved',
     (select count(*)::text from public.batches where map_run_id = pg_temp.j('ok')) || '/' || pg_temp.cnt('in_batch') || '/' || pg_temp.cnt('approved'), '3/5/3');

-- ===========================================================================
-- Items in a batch are frozen for review and structure edits
-- ===========================================================================
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('frozen', 'an in_batch item cannot be rejected / sent back (PM003), merged, split or moved (PM003)',
     pg_temp.try(format($q$select public.plan_items_set_status(%L, %L, %L, 'rejected')$q$, pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i1')])) || '/' ||
     pg_temp.try(format($q$select public.plan_items_set_status(%L, %L, %L, 'proposed')$q$, pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i6'), pg_temp.j('i1')])) || '/' ||
     pg_temp.try(format($q$select public.plan_item_merge(%L, %L, %L, %L)$q$, pg_temp.ua(), pg_temp.j('ok'), pg_temp.j('i6'), pg_temp.j('i3'))) || '/' ||
     pg_temp.try(format($q$select public.plan_items_move(%L, %L, %L, %L)$q$, pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i3')], pg_temp.j('s2'))), 'err:PM003/err:PM003/err:PM003/err:PM003'),
  ('frozen', 'approve-clean and re-approving leave in_batch items alone (nothing changes)',
     public.plan_items_approve_clean(pg_temp.ua(), pg_temp.j('ok'))::text || '/' || pg_temp.cnt('in_batch'), '0/5');
reset role;

-- ===========================================================================
-- Remove items, cancel
-- ===========================================================================
set role service_role;
insert into t_calls values ('rm1', public.batch_remove_items(pg_temp.ua(), pg_temp.b('b1'), array[pg_temp.j('i1')])::text);
insert into t_calls values ('rm1again', public.batch_remove_items(pg_temp.ua(), pg_temp.b('b1'), array[pg_temp.j('i1')])::text);
reset role;
insert into t_results (who, test, actual, expected) values
  ('remove', 'removing i1 returns it to approved without batch; a replay removes 0; the batch stays planned with i2',
     (select v from t_calls where k = 'rm1') || '/' || (select v from t_calls where k = 'rm1again') || '/' || pg_temp.st('i1') || '/' ||
     (select status from public.batches where id = pg_temp.b('b1')) || '/' || (select count(*)::text from public.plan_items where batch_id = pg_temp.b('b1')), '1/0/approved:-/planned/1');
set role service_role;
insert into t_calls values ('rm2', public.batch_remove_items(pg_temp.ua(), pg_temp.b('b1'), array[pg_temp.j('i2')])::text);
reset role;
insert into t_results (who, test, actual, expected) values
  ('remove', 'taking out the last item cancels the batch', (select v from t_calls where k = 'rm2') || '/' || (select status from public.batches where id = pg_temp.b('b1')) || '/' || pg_temp.st('i2'), '1/canceled/approved:-');
set role service_role;
insert into t_calls values ('c3', public.batch_cancel(pg_temp.ua(), pg_temp.b('b3'))::text);
insert into t_calls values ('c3again', public.batch_cancel(pg_temp.ua(), pg_temp.b('b3'))::text);
reset role;
insert into t_results (who, test, actual, expected) values
  ('cancel', 'cancelling the manual batch releases its 2 items; a replay returns 0',
     (select v from t_calls where k = 'c3') || '/' || (select v from t_calls where k = 'c3again') || '/' || (select status from public.batches where id = pg_temp.b('b3')) || '/' || pg_temp.st('i4') || '/' || pg_temp.st('i5'), '2/0/canceled/approved:-/approved:-'),
  ('cancel', 'now 1 item (i3) is in a batch and 7 are approved', pg_temp.cnt('in_batch') || '/' || pg_temp.cnt('approved'), '1/7');
-- released items can be batched again
set role service_role;
insert into t_calls values ('again', public.batches_create(pg_temp.ua(), pg_temp.j('ok'), jsonb_build_array(jsonb_build_object('name', 'second try', 'item_ids', jsonb_build_array(pg_temp.j('i4'), pg_temp.j('i5')))), 'manual')::text);
insert into t_results (who, test, actual, expected) values
  ('cancel', 'released items go into a new batch (position continues: 4)',
     (select position::text from public.batches where id = pg_temp.arr('again', 1)), '4');
-- gates of cancel / remove
insert into t_results (who, test, actual, expected) values
  ('gate', 'stranger 42501, unknown batch PM004 for cancel and remove',
     pg_temp.try(format($q$select public.batch_cancel(%L, %L)$q$, pg_temp.ub(), pg_temp.b('b2'))) || '/' ||
     pg_temp.try(format($q$select public.batch_remove_items(%L, %L, %L)$q$, pg_temp.ub(), pg_temp.b('b2'), array[pg_temp.j('i3')])) || '/' ||
     pg_temp.try(format($q$select public.batch_cancel(%L, gen_random_uuid())$q$, pg_temp.ua())) || '/' ||
     pg_temp.try(format($q$select public.batch_remove_items(%L, gen_random_uuid(), %L)$q$, pg_temp.ua(), array[pg_temp.j('i3')])), 'err:42501/err:42501/err:PM004/err:PM004'),
  ('gate', 'remove with no ids is 22023',
     pg_temp.try(format($q$select public.batch_remove_items(%L, %L, '{}')$q$, pg_temp.ua(), pg_temp.b('b2'))), 'err:22023');
reset role;
update public.batches set status = 'running' where id = pg_temp.b('b2');
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('gate', 'a running batch can neither be cancelled nor lose items (PM003); its items stay in_batch',
     pg_temp.try(format($q$select public.batch_cancel(%L, %L)$q$, pg_temp.ua(), pg_temp.b('b2'))) || '/' ||
     pg_temp.try(format($q$select public.batch_remove_items(%L, %L, %L)$q$, pg_temp.ua(), pg_temp.b('b2'), array[pg_temp.j('i3')])) || '/' || pg_temp.st('i3'),
     'err:PM003/err:PM003/in_batch:' || pg_temp.b('b2'));
reset role;

-- ===========================================================================
-- Table constraints
-- ===========================================================================
insert into t_results (who, test, actual, expected) values
  ('constraint', 'in_batch without a batch, and a batch id on an approved item, are refused (23514); a batch with items cannot be deleted (23503)',
     pg_temp.try(format($q$update public.plan_items set status = 'in_batch' where id = %L$q$, pg_temp.j('i6'))) || '/' ||
     pg_temp.try(format($q$update public.plan_items set batch_id = %L where id = %L$q$, pg_temp.b('b2'), pg_temp.j('i6'))) || '/' ||
     pg_temp.try(format($q$delete from public.batches where id = %L$q$, pg_temp.b('b2'))), 'err:23514/err:23514/err:23503'),
  ('constraint', 'a bad batch status / origin / empty name are refused (23514)',
     pg_temp.try(format($q$update public.batches set status = 'bogus' where id = %L$q$, pg_temp.b('b2'))) || '/' ||
     pg_temp.try(format($q$update public.batches set origin = 'bogus' where id = %L$q$, pg_temp.b('b2'))) || '/' ||
     pg_temp.try(format($q$update public.batches set name = '  ' where id = %L$q$, pg_temp.b('b2'))), 'err:23514/err:23514/err:23514');

-- ===========================================================================
-- RLS: members read their workspace's batches, nobody writes from the client
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"a1610101-0000-0000-0000-000000000001","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'a1610101-0000-0000-0000-000000000001', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('A', 'sees own 4 batches (3 + the second try), none of another workspace',
     (select count(*) from public.batches)::text || '/' || (select count(*) from public.batches where workspace_id <> pg_temp.wsa())::text, '4/0'),
  ('A', 'cannot insert, update or delete a batch',
     pg_temp.try(format($q$insert into public.batches (workspace_id, project_id, map_run_id, name, origin) select workspace_id, project_id, id, 'hack', 'manual' from public.map_runs where id = %L$q$, pg_temp.j('ok'))) || '/' ||
     pg_temp.try(format($q$update public.batches set name = 'hack' where id = %L$q$, pg_temp.b('b2'))) || '/' ||
     pg_temp.try(format($q$delete from public.batches where id = %L$q$, pg_temp.b('b2'))), 'err:42501/err:42501/err:42501'),
  ('A', 'cannot execute the batch functions',
     pg_temp.try(format($q$select public.batch_cancel(%L, %L)$q$, pg_temp.ua(), pg_temp.b('b2'))) || '/' ||
     pg_temp.try(format($q$select public.batches_create(%L, %L, '[]'::jsonb, 'auto')$q$, pg_temp.ua(), pg_temp.j('ok'))) || '/' ||
     pg_temp.try(format($q$select public.batch_remove_items(%L, %L, %L)$q$, pg_temp.ua(), pg_temp.b('b2'), array[pg_temp.j('i3')])) || '/' ||
     pg_temp.try(format($q$select public.batch_edit_guard(%L, %L)$q$, pg_temp.ua(), pg_temp.b('b2'))), 'err:42501/err:42501/err:42501/err:42501');
reset role;
select set_config('request.jwt.claims', '{"sub":"b1610101-0000-0000-0000-000000000002","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'b1610101-0000-0000-0000-000000000002', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('B', 'a stranger sees no batch', (select count(*)::text from public.batches), '0');
reset role;
select set_config('request.jwt.claims', '{}', false);

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a1610101-0000-0000-0000-000000000001','b1610101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a1610101-0000-0000-0000-000000000001','b1610101-0000-0000-0000-000000000002');

select n, who, test, actual, expected, (actual = expected) as pass from t_results
union all
select 9999, 'ALL CHECKS', (select count(*) filter (where actual = expected) from t_results)::text || ' of ' || (select count(*) from t_results)::text || ' passed', '', '',
       (select bool_and(actual = expected) from t_results)
order by 1;
