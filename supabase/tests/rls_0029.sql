-- rls_0029.sql — tests for migration 0029 (manual add of a keyword to a finished map)
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0021-0029 are applied). Safe to re-run.
-- Runs as ONE transaction on Supabase; nothing here depends on now() ordering.
-- EXPECTED OUTPUT: every row pass = true; last row  ALL CHECKS | <N> of <N> passed | (blank) | (blank) | true

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a2910101-0000-0000-0000-000000000001','b2910101-0000-0000-0000-000000000002','c2910101-0000-0000-0000-000000000003');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a2910101-0000-0000-0000-000000000001','b2910101-0000-0000-0000-000000000002','c2910101-0000-0000-0000-000000000003');

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('a2910101-0000-0000-0000-000000000001','authenticated','authenticated','a29@example.test', now()),
  ('b2910101-0000-0000-0000-000000000002','authenticated','authenticated','b29@example.test', now()),
  ('c2910101-0000-0000-0000-000000000003','authenticated','authenticated','c29@example.test', now());
create temp table t_ws as select owner_id as uid, id as ws from public.workspaces
  where owner_id in ('a2910101-0000-0000-0000-000000000001','b2910101-0000-0000-0000-000000000002');
grant select on t_ws to anon, authenticated, service_role;
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to anon, authenticated, service_role;
create temp table t_calls (k text primary key, v text);
grant all on t_calls to anon, authenticated, service_role;
create function pg_temp.wsa() returns uuid language sql as $$ select ws from t_ws where uid = 'a2910101-0000-0000-0000-000000000001' $$;
create function pg_temp.wsb() returns uuid language sql as $$ select ws from t_ws where uid = 'b2910101-0000-0000-0000-000000000002' $$;
create function pg_temp.j(k text) returns uuid language sql as $$ select v from t_ids where k = $1 $$;
create function pg_temp.ua() returns uuid language sql as $$ select 'a2910101-0000-0000-0000-000000000001'::uuid $$;
create function pg_temp.ub() returns uuid language sql as $$ select 'b2910101-0000-0000-0000-000000000002'::uuid $$;
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

create function pg_temp.uc() returns uuid language sql as $$ select 'c2910101-0000-0000-0000-000000000003'::uuid $$;
grant execute on function pg_temp.uc() to anon, authenticated, service_role;

insert into public.workspace_members (workspace_id, user_id, role) values (pg_temp.wsa(), pg_temp.uc(), 'member');
-- A: finished run "ok" (silo s1 = i1..i4 with pillar i1, silo s2 = i5..i8), unfinished run "live", and a second finished run "other" (its own silo/item)
set role service_role;
select public.credit_adjust(pg_temp.wsa(), 300, 'test_grant', 'test-0029:' || pg_temp.wsa()::text, 'test', 'x');
insert into t_ids values ('ok',    public.map_run_create(pg_temp.wsa(), pg_temp.ua(), 'peinados', 'es', 'es-MX', 20, 50, 'fast', 'k-a29-ok'));
insert into t_ids values ('live',  public.map_run_create(pg_temp.wsa(), pg_temp.ua(), 'tatuajes', 'es', 'es-MX', 20, 50, 'fast', 'k-a29-live'));
insert into t_ids values ('other', public.map_run_create(pg_temp.wsa(), pg_temp.ua(), 'uñas', 'es', 'es-MX', 20, 50, 'fast', 'k-a29-other'));
reset role;
insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, seq, status)
select pg_temp.wsa(), pg_temp.j('ok'), 'kw' || g, 'kw' || g, 'es', 'test', g, 'primary' from generate_series(1, 8) g;
insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, seq, status, merged_into)
select pg_temp.wsa(), pg_temp.j('ok'), 'v2a', 'v2a', 'es', 'test', 20, 'merged', id from public.kw_candidates where map_run_id = pg_temp.j('ok') and raw = 'kw2';
insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, seq, status)
select pg_temp.wsa(), pg_temp.j('other'), 'ow1', 'ow1', 'es', 'test', 1, 'primary';
insert into public.silos (workspace_id, project_id, map_run_id, name, position)
select pg_temp.wsa(), project_id, id, 'silo ' || s, s from public.map_runs, generate_series(1, 2) s where id = pg_temp.j('ok');
insert into public.silos (workspace_id, project_id, map_run_id, name, position)
select pg_temp.wsa(), project_id, id, 'other silo', 1 from public.map_runs where id = pg_temp.j('other');
insert into t_ids select 's' || position, id from public.silos where map_run_id = pg_temp.j('ok');
insert into t_ids select 'so', id from public.silos where map_run_id = pg_temp.j('other');
insert into public.plan_items (workspace_id, project_id, map_run_id, silo_id, primary_kw_id, keyword, article_type, position, variants, list_count)
select pg_temp.wsa(), r.project_id, r.id, case when c.seq <= 4 then pg_temp.j('s1') else pg_temp.j('s2') end, c.id, c.raw, 'A', c.seq,
       case c.raw when 'kw2' then array['v2a'] else '{}'::text[] end, case when c.seq = 1 then 9 else null end
from public.map_runs r join public.kw_candidates c on c.map_run_id = r.id where r.id = pg_temp.j('ok') and c.status = 'primary';
insert into public.plan_items (workspace_id, project_id, map_run_id, silo_id, primary_kw_id, keyword, article_type, position)
select pg_temp.wsa(), r.project_id, r.id, pg_temp.j('so'), c.id, c.raw, 'A', c.seq from public.map_runs r join public.kw_candidates c on c.map_run_id = r.id where r.id = pg_temp.j('other');
insert into t_ids select 'i' || position, id from public.plan_items where map_run_id = pg_temp.j('ok');
insert into t_ids select 'io', id from public.plan_items where map_run_id = pg_temp.j('other');
update public.silos set pillar_item_id = pg_temp.j('i1') where id = pg_temp.j('s1');
update public.silos set pillar_item_id = pg_temp.j('i5') where id = pg_temp.j('s2');
update public.silos set pillar_item_id = pg_temp.j('io') where id = pg_temp.j('so');
select public.plan_links_fix(pg_temp.j('ok'));
select public.plan_links_fix(pg_temp.j('other'));
set role service_role;
select public.map_run_set_report(pg_temp.j('ok'), '{"verdict":"pass","checks":[]}'::jsonb);
select public.map_run_finish(pg_temp.j('ok'), 'succeeded');
select public.map_run_set_report(pg_temp.j('other'), '{"verdict":"pass","checks":[]}'::jsonb);
select public.map_run_finish(pg_temp.j('other'), 'succeeded');
reset role;
update public.plan_items set status = 'approved' where id = pg_temp.j('i3');

create function pg_temp.am(u uuid, run text, txt text, title text, silo text, f boolean) returns text language plpgsql as $$
begin return pg_temp.call(format($q$select public.plan_item_add_manual(%L, %L, %L, %L, %s, %L)::text$q$, u, pg_temp.j(run), txt, title, case when silo is null then 'null' else quote_literal(pg_temp.j(silo)) end, f)); end $$;
create function pg_temp.av(u uuid, run text, item text, txt text) returns text language plpgsql as $$
begin return pg_temp.call(format($q$select public.plan_item_add_variant(%L, %L, %L, %L)::text$q$, u, pg_temp.j(run), pg_temp.j(item), txt)); end $$;
grant execute on function pg_temp.am(uuid, text, text, text, text, boolean), pg_temp.av(uuid, text, text, text) to anon, authenticated, service_role;

set role service_role;
insert into t_calls values ('m_ok', pg_temp.am(pg_temp.ua(), 'ok', '  Peinados   para bodas ', null, 's1', false));
insert into t_calls values ('m_title_forced', pg_temp.am(pg_temp.ua(), 'ok', 'trenzas de lado', 'Trenzas de lado paso a paso', 's2', true));
insert into t_calls values ('m_dup_case', pg_temp.am(pg_temp.ua(), 'ok', 'PEINADOS PARA BODAS', null, 's1', false));
insert into t_calls values ('m_dup_existing', pg_temp.am(pg_temp.ua(), 'ok', 'KW3', null, 's1', false));
insert into t_calls values ('m_dup_variant_text', pg_temp.am(pg_temp.ua(), 'ok', 'v2a', null, 's1', false));
insert into t_calls values ('m_stranger', pg_temp.am(pg_temp.ub(), 'ok', 'nuevo uno', null, 's1', false));
insert into t_calls values ('m_unfinished', pg_temp.am(pg_temp.ua(), 'live', 'nuevo dos', null, 's1', false));
insert into t_calls values ('m_foreign_silo', pg_temp.am(pg_temp.ua(), 'ok', 'nuevo tres', null, 'so', false));
insert into t_calls values ('m_null_silo', pg_temp.am(pg_temp.ua(), 'ok', 'nuevo cuatro', null, null, false));
insert into t_calls values ('m_empty', pg_temp.am(pg_temp.ua(), 'ok', '   ', null, 's1', false));
insert into t_calls values ('m_long', pg_temp.am(pg_temp.ua(), 'ok', repeat('x', 201), null, 's1', false));
insert into t_calls values ('m_words', pg_temp.am(pg_temp.ua(), 'ok', 'a b c d e f g h i j k l m', null, 's1', false));
insert into t_calls values ('m_member', pg_temp.am(pg_temp.uc(), 'ok', 'por un miembro', null, 's1', false));
reset role;
insert into t_calls values ('m_item1', (select keyword || '/' || status || '/' || array_to_string(flags, '+') || '/' || coalesce(title, 'null') || '/' || list_count || '/' || (silo_id = pg_temp.j('s1'))::text || '/' || article_type from public.plan_items where id = (select v::uuid from t_calls where k = 'm_ok')));
insert into t_calls values ('m_cand1', (select source || '/' || status || '/' || raw_key || '/' || lang from public.kw_candidates where id = (select primary_kw_id from public.plan_items where id = (select v::uuid from t_calls where k = 'm_ok'))));
insert into t_calls values ('m_item2', (select status || '/' || array_to_string(flags, '+') || '/' || title from public.plan_items where id = (select v::uuid from t_calls where k = 'm_title_forced')));
insert into t_calls values ('m_silo_size', (select size::text from public.silos where id = pg_temp.j('s1')));
insert into t_calls values ('m_items_total', (select count(*)::text from public.plan_items where map_run_id = pg_temp.j('ok')));

set role service_role;
insert into t_calls values ('v_ok', pg_temp.av(pg_temp.ua(), 'ok', 'i2', 'Peinado Sencillo Boda'));
insert into t_calls values ('v_dup', pg_temp.av(pg_temp.ua(), 'ok', 'i2', 'peinado sencillo boda'));
insert into t_calls values ('v_dup_other_item', pg_temp.av(pg_temp.ua(), 'ok', 'i4', 'kw5'));
insert into t_calls values ('v_approved', pg_temp.av(pg_temp.ua(), 'ok', 'i3', 'otra variante'));
insert into t_calls values ('v_foreign_item', pg_temp.av(pg_temp.ua(), 'ok', 'io', 'otra variante dos'));
insert into t_calls values ('v_stranger', pg_temp.av(pg_temp.ub(), 'ok', 'i2', 'otra variante tres'));
insert into t_calls values ('v_empty', pg_temp.av(pg_temp.ua(), 'ok', 'i2', ' '));
reset role;
insert into t_calls values ('v_item', (select array_to_string(variants, '|') || '/' || array_to_string(flags, '+') from public.plan_items where id = pg_temp.j('i2')));
insert into t_calls values ('v_cand', (select status || '/' || source || '/' || merge_reason || '/' || (merged_into = (select primary_kw_id from public.plan_items where id = pg_temp.j('i2')))::text from public.kw_candidates where map_run_id = pg_temp.j('ok') and raw_key = 'peinado sencillo boda'));
insert into t_calls values ('v_items_total', (select count(*)::text from public.plan_items where map_run_id = pg_temp.j('ok')));

insert into t_results (who, test, actual, expected) values
  ('service', 'a new item: trimmed text, proposed, needs_title, picked silo, list_count borrowed from the silo, type A', (select v from t_calls where k = 'm_item1'), 'Peinados para bodas/proposed/manual_add+needs_title/null/9/true/A'),
  ('service', 'its candidate is a primary manual one with the lower-case key', (select v from t_calls where k = 'm_cand1'), 'manual/primary/peinados para bodas/es'),
  ('service', 'with a title and force: no needs_title, flag forced', (select v from t_calls where k = 'm_item2'), 'proposed/manual_add+forced/Trenzas de lado paso a paso'),
  ('service', 'the same text in other capitals is refused (PM006)', (select v from t_calls where k = 'm_dup_case'), 'err:PM006'),
  ('service', 'a keyword already in the map is refused (PM006)', (select v from t_calls where k = 'm_dup_existing'), 'err:PM006'),
  ('service', 'a text that is already a variant is refused (PM006)', (select v from t_calls where k = 'm_dup_variant_text'), 'err:PM006'),
  ('service', 'a non-member is refused (42501)', (select v from t_calls where k = 'm_stranger'), 'err:42501'),
  ('service', 'an unfinished run is refused (PM003)', (select v from t_calls where k = 'm_unfinished'), 'err:PM003'),
  ('service', 'a silo of another run is refused (PM004)', (select v from t_calls where k = 'm_foreign_silo'), 'err:PM004'),
  ('service', 'no silo is refused (PM004)', (select v from t_calls where k = 'm_null_silo'), 'err:PM004'),
  ('service', 'empty text is refused (22023)', (select v from t_calls where k = 'm_empty'), 'err:22023'),
  ('service', 'text over 200 characters is refused (22023)', (select v from t_calls where k = 'm_long'), 'err:22023'),
  ('service', 'more than 12 words is refused (22023)', (select v from t_calls where k = 'm_words'), 'err:22023'),
  ('service', 'a plain member may add (any member of the workspace)', (select (v ~ '^[0-9a-f-]{36}$')::text from t_calls where k = 'm_member'), 'true'),
  ('service', 'silo size follows (4 + 3 added to s1 = 7)', (select v from t_calls where k = 'm_silo_size'), '6'),
  ('service', 'only the three accepted adds created items (8 + 3)', (select v from t_calls where k = 'm_items_total'), '11'),
  ('service', 'a variant is added to an item', (select v from t_calls where k = 'v_ok'), '1'),
  ('service', 'the same variant again (other capitals) is refused (PM006)', (select v from t_calls where k = 'v_dup'), 'err:PM006'),
  ('service', 'a keyword that is another item is refused (PM006)', (select v from t_calls where k = 'v_dup_other_item'), 'err:PM006'),
  ('service', 'an approved item cannot get a variant (PM003)', (select v from t_calls where k = 'v_approved'), 'err:PM003'),
  ('service', 'an item of another run is refused (PM004)', (select v from t_calls where k = 'v_foreign_item'), 'err:PM004'),
  ('service', 'a non-member cannot add a variant (42501)', (select v from t_calls where k = 'v_stranger'), 'err:42501'),
  ('service', 'empty variant text is refused (22023)', (select v from t_calls where k = 'v_empty'), 'err:22023'),
  ('service', 'the item now lists the variant (after the existing one) and is flagged', (select v from t_calls where k = 'v_item'), 'v2a|Peinado Sencillo Boda/manual_variant'),
  ('service', 'the variant candidate is merged into the item''s primary (manual_add)', (select v from t_calls where k = 'v_cand'), 'merged/manual/manual_add/true'),
  ('service', 'a variant creates no new item', (select v from t_calls where k = 'v_items_total'), '11');

select set_config('request.jwt.claims', '{"sub":"a2910101-0000-0000-0000-000000000001","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'a2910101-0000-0000-0000-000000000001', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('A', 'cannot call plan_item_add_manual (service only)', pg_temp.sql_try(format($q$select public.plan_item_add_manual(%L, %L, 'x y', null, %L, false)$q$, pg_temp.ua(), pg_temp.j('ok'), pg_temp.j('s1'))), 'err:42501'),
  ('A', 'cannot call plan_item_add_variant (service only)', pg_temp.sql_try(format($q$select public.plan_item_add_variant(%L, %L, %L, 'x y')$q$, pg_temp.ua(), pg_temp.j('ok'), pg_temp.j('i2'))), 'err:42501'),
  ('A', 'a member reads the new items', (select count(*)::text from public.plan_items where map_run_id = pg_temp.j('ok') and 'manual_add' = any (flags)), '3');
reset role;
select set_config('request.jwt.claims', '{"sub":"b2910101-0000-0000-0000-000000000002","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'b2910101-0000-0000-0000-000000000002', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('B', 'a stranger sees none of the items', (select count(*)::text from public.plan_items where map_run_id = pg_temp.j('ok')), '0');
reset role;
select set_config('request.jwt.claims', '{}', false);

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a2910101-0000-0000-0000-000000000001','b2910101-0000-0000-0000-000000000002','c2910101-0000-0000-0000-000000000003');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a2910101-0000-0000-0000-000000000001','b2910101-0000-0000-0000-000000000002','c2910101-0000-0000-0000-000000000003');

select n, who, test, actual, expected, (actual = expected) as pass from t_results
union all
select 9999, 'ALL CHECKS', (select count(*) filter (where actual = expected) from t_results)::text || ' of ' || (select count(*) from t_results)::text || ' passed', '', '',
       (select bool_and(actual = expected) from t_results)
order by 1;
