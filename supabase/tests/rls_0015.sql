-- rls_0015.sql — tests for migration 0014 (merge / split / move plan items by hand: gates, structure, link plans)
-- rls_0015.sql — tests for migration 0015 (item status vocabulary: constraint, rename draft->proposed, frozen items, review rules)
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0008-0015 are applied). Safe to re-run.
-- Creates two throw-away users (A owns the runs, B is a stranger) and removes everything at the end.
-- EXPECTED OUTPUT: every row pass = true; last row  ALL CHECKS | <N> of <N> passed | (blank) | (blank) | true

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a1510101-0000-0000-0000-000000000001','b1510101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a1510101-0000-0000-0000-000000000001','b1510101-0000-0000-0000-000000000002');

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('a1510101-0000-0000-0000-000000000001','authenticated','authenticated','a15@example.test', now()),
  ('b1510101-0000-0000-0000-000000000002','authenticated','authenticated','b15@example.test', now());
create temp table t_ws as select owner_id as uid, id as ws from public.workspaces
  where owner_id in ('a1510101-0000-0000-0000-000000000001','b1510101-0000-0000-0000-000000000002');
grant select on t_ws to anon, authenticated, service_role;
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to anon, authenticated, service_role;
create function pg_temp.wsa() returns uuid language sql as $$ select ws from t_ws where uid = 'a1510101-0000-0000-0000-000000000001' $$;
create function pg_temp.j(k text) returns uuid language sql as $$ select v from t_ids where k = $1 $$;
grant execute on function pg_temp.wsa(), pg_temp.j(text) to anon, authenticated, service_role;
create function pg_temp.ua() returns uuid language sql as $$ select 'a1510101-0000-0000-0000-000000000001'::uuid $$;
create function pg_temp.ub() returns uuid language sql as $$ select 'b1510101-0000-0000-0000-000000000002'::uuid $$;
grant execute on function pg_temp.ua(), pg_temp.ub() to anon, authenticated, service_role;

set role service_role;
select public.credit_adjust(pg_temp.wsa(), 100, 'test_grant', 'test-0015:' || pg_temp.wsa()::text, 'test', 'x');
insert into t_ids values ('ok',   public.map_run_create(pg_temp.wsa(), pg_temp.ua(), 'peinados', 'es', 'es-MX', 20, 50, 'fast', 'k-a15-ok'));
insert into t_ids values ('live', public.map_run_create(pg_temp.wsa(), pg_temp.ua(), 'tatuajes', 'es', 'es-MX', 20, 50, 'fast', 'k-a15-live'));
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

-- ===========================================================================
-- Vocabulary
-- ===========================================================================
insert into t_results (who, test, actual, expected) values
  ('vocab', 'new items start as proposed; no item anywhere is still called draft',
     (select string_agg(distinct status, ',') from public.plan_items where map_run_id = pg_temp.j('ok')) || '/' ||
     (select count(*)::text from public.plan_items where status = 'draft'), 'proposed/0'),
  ('vocab', 'the old name draft and an unknown name are refused by the constraint (23514)',
     pg_temp.try(format($q$update public.plan_items set status = 'draft' where id = %L$q$, pg_temp.j('i1'))) || '/' ||
     pg_temp.try(format($q$update public.plan_items set status = 'bogus' where id = %L$q$, pg_temp.j('i1'))), 'err:23514/err:23514'),
  ('vocab', 'all 12 PLAN names are accepted',
     (select count(*)::text from unnest(array['proposed','approved','in_batch','writing','draft_ready','in_review','scheduled','published','pins_pending','done','rejected','already_exists']) s
        where pg_temp.try(format($q$select 1 from public.plan_items where status = %L$q$, s)) = 'ok'), '12');
-- the check constraint itself, read from the catalog
insert into t_results (who, test, actual, expected) values
  ('vocab', 'the constraint lists exactly 12 statuses',
     (select (length(pg_get_constraintdef(oid)) - length(replace(pg_get_constraintdef(oid), '::text', '')))/6 || '' from pg_constraint where conname = 'plan_items_status_check' and conrelid = 'public.plan_items'::regclass), '12');

-- ===========================================================================
-- Review rules with the new names
-- ===========================================================================
set role service_role;
create temp table t_calls (k text primary key, v text);
grant all on t_calls to anon, authenticated, service_role;
insert into t_calls values ('appr', public.plan_items_set_status(pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i1'), pg_temp.j('i2')], 'approved')::text);
insert into t_calls values ('back', public.plan_items_set_status(pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i2')], 'proposed')::text);
insert into t_calls values ('clean', public.plan_items_approve_clean(pg_temp.ua(), pg_temp.j('ok'))::text);
reset role;
insert into t_results (who, test, actual, expected) values
  ('review', 'approve 2, send 1 back to proposed, approve-clean then approves the 6 remaining unflagged proposed items',
     (select v from t_calls where k = 'appr') || '/' || (select v from t_calls where k = 'back') || '/' || (select v from t_calls where k = 'clean'), '2/1/7'),
  ('review', 'result: all 8 approved (i1 was approved before, i2 came back and was approved again)',
     (select count(*)::text from public.plan_items where map_run_id = pg_temp.j('ok') and status = 'approved'), '8');
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('review', 'draft, in_batch and unknown names cannot be set from the review page (22023)',
     pg_temp.try(format($q$select public.plan_items_set_status(%L, %L, %L, 'draft')$q$, pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i1')])) || '/' ||
     pg_temp.try(format($q$select public.plan_items_set_status(%L, %L, %L, 'in_batch')$q$, pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i1')])) || '/' ||
     pg_temp.try(format($q$select public.plan_items_set_status(%L, %L, %L, 'x')$q$, pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i1')])), 'err:22023/err:22023/err:22023');
select public.plan_items_set_status(pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i1'), pg_temp.j('i2'), pg_temp.j('i3'), pg_temp.j('i4'), pg_temp.j('i5'), pg_temp.j('i6'), pg_temp.j('i7'), pg_temp.j('i8')], 'proposed');
reset role;

-- ===========================================================================
-- Items further along are frozen (i7 is 'writing', as a later phase will set it; set directly here)
-- ===========================================================================
update public.plan_items set status = 'writing' where id = pg_temp.j('i7');
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('frozen', 'a writing item cannot be approved/rejected/proposed from review (PM003), also not mixed in with others',
     pg_temp.try(format($q$select public.plan_items_set_status(%L, %L, %L, 'rejected')$q$, pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i7')])) || '/' ||
     pg_temp.try(format($q$select public.plan_items_set_status(%L, %L, %L, 'approved')$q$, pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i6'), pg_temp.j('i7')])), 'err:PM003/err:PM003'),
  ('frozen', 'a writing item cannot be merged (either side), split or moved (PM003)',
     pg_temp.try(format($q$select public.plan_item_merge(%L, %L, %L, %L)$q$, pg_temp.ua(), pg_temp.j('ok'), pg_temp.j('i7'), pg_temp.j('i8'))) || '/' ||
     pg_temp.try(format($q$select public.plan_item_merge(%L, %L, %L, %L)$q$, pg_temp.ua(), pg_temp.j('ok'), pg_temp.j('i8'), pg_temp.j('i7'))) || '/' ||
     pg_temp.try(format($q$select public.plan_items_move(%L, %L, %L, %L)$q$, pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i7')], pg_temp.j('s1'))), 'err:PM003/err:PM003/err:PM003'),
  ('frozen', 'a rejected item may still be restructured (move works), as before',
     public.plan_items_set_status(pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i6')], 'rejected')::text || '/' ||
     public.plan_items_move(pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i6')], pg_temp.j('s1'))::text, '1/1'),
  ('frozen', 'a frozen failure changed nothing (i7 still writing, i8 still there)',
     (select status from public.plan_items where id = pg_temp.j('i7')) || '/' || (select count(*)::text from public.plan_items where id = pg_temp.j('i8')), 'writing/1');
-- split makes a proposed item
insert into t_calls values ('split', public.plan_item_split(pg_temp.ua(), pg_temp.j('ok'), pg_temp.j('i2'), 'v2a')::text);
reset role;
insert into t_results (who, test, actual, expected) values
  ('split', 'the item made by a split is proposed',
     (select status from public.plan_items where id = (select v::uuid from t_calls where k = 'split')), 'proposed');

-- privileges
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('privilege', 'authenticated cannot run the review functions or the frozen helper',
     pg_temp.try(format($q$select public.plan_items_set_status(%L, %L, %L, 'approved')$q$, pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i1')])) || '/' ||
     pg_temp.try(format($q$select public.plan_items_approve_clean(%L, %L)$q$, pg_temp.ua(), pg_temp.j('ok'))) || '/' ||
     pg_temp.try($q$select public.plan_item_is_frozen('done')$q$), 'err:42501/err:42501/err:42501');
reset role;

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a1510101-0000-0000-0000-000000000001','b1510101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a1510101-0000-0000-0000-000000000001','b1510101-0000-0000-0000-000000000002');

select n, who, test, actual, expected, (actual = expected) as pass from t_results
union all
select 9999, 'ALL CHECKS', (select count(*) filter (where actual = expected) from t_results)::text || ' of ' || (select count(*) from t_results)::text || ' passed', '', '',
       (select bool_and(actual = expected) from t_results)
order by 1;
