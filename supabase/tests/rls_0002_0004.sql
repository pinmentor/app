-- rls_0002_0004.sql — tests for migrations 0002 (credit ledger), 0003 (events/audit), 0004 (admin)
--
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0002, 0003, 0004 are applied).
-- It creates 3 throw-away users (fixed UUIDs), exercises the ledger / RLS / grants / audit as the
-- relevant roles, removes everything it created, and ends with ONE result table.
-- Safe to re-run. (The 50-parallel-reserve test is a shell script: supabase/tests/credit_concurrency.sh.)
--
-- EXPECTED OUTPUT: every row has pass = true and the last row reads
--   ALL CHECKS  |  <N> of <N> passed  |  (blank) | (blank) | true
-- Any `false` row = a real bug -> do not ship; send me the table.
--
-- Users: A = aaaaaaaa-... (confirmed), B = bbbbbbbb-... (confirmed, promoted to superadmin in the test),
--        C = cccccccc-... (unconfirmed at first)

reset role;

-- leftovers from an earlier run (audit rows are append-only, so lift the guard for test rows only)
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where target_id in (select id::text from public.workspaces where owner_id in (
  'aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000002','cccccccc-0000-0000-0000-000000000003'));
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003');

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;

-- helper: run a statement, record 'ok' or the SQLSTATE it raised
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Setup: A, B confirmed at signup; C unconfirmed
-- ---------------------------------------------------------------------------
insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('aaaaaaaa-0000-0000-0000-000000000001','authenticated','authenticated','a@example.test', now()),
  ('bbbbbbbb-0000-0000-0000-000000000002','authenticated','authenticated','b@example.test', now()),
  ('cccccccc-0000-0000-0000-000000000003','authenticated','authenticated','c@example.test', null);

create temp table t_ws as
  select owner_id as uid, id as ws from public.workspaces
  where owner_id in ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000002','cccccccc-0000-0000-0000-000000000003');
grant select on t_ws to anon, authenticated, service_role;

create function pg_temp.ws(u uuid) returns uuid language sql as $$ select ws from t_ws where uid = u $$;
grant execute on function pg_temp.ws(uuid) to anon, authenticated, service_role;
create function pg_temp.bal(w uuid) returns text language sql as $$
  select available || '/' || held from public.credit_balance(w) $$;

-- ===========================================================================
-- 0.4 LEDGER (as postgres: the functions are service_role-only, postgres may call them)
-- ===========================================================================
insert into t_results (who, test, actual, expected) values
  ('ledger', 'trial grant landed in ledger for A (+30 committed, 1 row)',
     (select count(*) || '/' || coalesce(sum(delta),0) || '/' || min(status) from public.credit_ledger
        where workspace_id = pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001') and reason = 'trial_grant'), '1/30/committed'),
  ('ledger', 'A balance 30/0 (available/held)', pg_temp.bal(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')), '30/0'),
  ('ledger', 'unconfirmed C has 0/0 and no ledger rows',
     pg_temp.bal(pg_temp.ws('cccccccc-0000-0000-0000-000000000003')) || '/' ||
     (select count(*) from public.credit_ledger where workspace_id = pg_temp.ws('cccccccc-0000-0000-0000-000000000003')), '0/0/0');

update auth.users set email_confirmed_at = now() where id = 'cccccccc-0000-0000-0000-000000000003';
insert into t_results (who, test, actual, expected) values
  ('ledger', 'after C confirms: trial in ledger, balance 30/0',
     pg_temp.bal(pg_temp.ws('cccccccc-0000-0000-0000-000000000003')), '30/0');

-- reserve / idempotency
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to anon, authenticated, service_role;

insert into t_ids select 'r1', public.credit_reserve(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 10, 'article', 'test:r1', 'article', 'x1');
insert into t_results (who, test, actual, expected) values
  ('ledger', 'reserve 10 -> available 20, held 10', pg_temp.bal(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')), '20/10'),
  ('ledger', 'same key again returns the SAME id, no second hold',
     (public.credit_reserve(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 10, 'article', 'test:r1') = (select v from t_ids where k = 'r1'))::text
       || '/' || pg_temp.bal(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')), 'true/20/10'),
  ('ledger', 'same key, different amount -> PM002 idempotency_conflict',
     pg_temp.try($q$select public.credit_reserve(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 11, 'article', 'test:r1')$q$), 'err:PM002'),
  ('ledger', 'same key, other workspace -> PM002',
     pg_temp.try($q$select public.credit_reserve(pg_temp.ws('bbbbbbbb-0000-0000-0000-000000000002'), 10, 'article', 'test:r1')$q$), 'err:PM002'),
  ('ledger', 'reserve more than available (25 > 20) -> PM001, nothing held',
     pg_temp.try($q$select public.credit_reserve(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 25, 'article', 'test:big')$q$)
       || '/' || pg_temp.bal(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')), 'err:PM001/20/10'),
  ('ledger', 'reserve 0 -> 22023', pg_temp.try($q$select public.credit_reserve(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 0, 'x', 'test:zero')$q$), 'err:22023'),
  ('ledger', 'reserve negative -> 22023', pg_temp.try($q$select public.credit_reserve(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), -5, 'x', 'test:neg')$q$), 'err:22023'),
  ('ledger', 'empty idempotency key -> 22023', pg_temp.try($q$select public.credit_reserve(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 5, 'x', '')$q$), 'err:22023');

-- commit / double commit / release-after-commit
insert into t_results (who, test, actual, expected) values
  ('ledger', 'commit -> committed, balance 20/0',
     public.credit_commit((select v from t_ids where k = 'r1')) || '/' || pg_temp.bal(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')), 'committed/20/0'),
  ('ledger', 'second commit is a no-op (no double charge): still 20/0',
     public.credit_commit((select v from t_ids where k = 'r1')) || '/' || pg_temp.bal(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')), 'committed/20/0'),
  ('ledger', 'release after commit -> PM003',
     pg_temp.try($q$select public.credit_release((select v from t_ids where k = 'r1'))$q$), 'err:PM003'),
  ('ledger', 'commit unknown id -> PM004',
     pg_temp.try($q$select public.credit_commit(gen_random_uuid())$q$), 'err:PM004');

-- reserve then release
insert into t_ids select 'r2', public.credit_reserve(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 5, 'article', 'test:r2');
insert into t_results (who, test, actual, expected) values
  ('ledger', 'reserve 5 -> 15/5', pg_temp.bal(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')), '15/5'),
  ('ledger', 'release -> released, balance back to 20/0',
     public.credit_release((select v from t_ids where k = 'r2')) || '/' || pg_temp.bal(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')), 'released/20/0'),
  ('ledger', 'second release is a no-op',
     public.credit_release((select v from t_ids where k = 'r2')) || '/' || pg_temp.bal(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')), 'released/20/0'),
  ('ledger', 'commit after release -> PM003',
     pg_temp.try($q$select public.credit_commit((select v from t_ids where k = 'r2'))$q$), 'err:PM003');

-- adjust (grant / revoke)
insert into t_ids select 'g1', public.credit_adjust(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 50, 'test grant', 'test:g1');
insert into t_results (who, test, actual, expected) values
  ('ledger', 'adjust +50 -> 70/0', pg_temp.bal(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')), '70/0'),
  ('ledger', 'same adjust key again: same id, balance unchanged',
     (public.credit_adjust(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 50, 'test grant', 'test:g1') = (select v from t_ids where k = 'g1'))::text
       || '/' || pg_temp.bal(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')), 'true/70/0'),
  ('ledger', 'revoke more than balance (-100) -> PM001',
     pg_temp.try($q$select public.credit_adjust(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), -100, 'test revoke', 'test:g2')$q$), 'err:PM001'),
  ('ledger', 'revoke exactly the balance (-70) works -> 0/0',
     (public.credit_adjust(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), -70, 'test revoke', 'test:g3') is not null)::text
       || '/' || pg_temp.bal(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')), 'true/0/0'),
  ('ledger', 'adjust 0 -> 22023', pg_temp.try($q$select public.credit_adjust(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 0, 'x', 'test:g4')$q$), 'err:22023');

-- immutability (as postgres: even the owner cannot rewrite history)
insert into t_ids select 'r3', public.credit_reserve(pg_temp.ws('bbbbbbbb-0000-0000-0000-000000000002'), 3, 'article', 'test:r3');
insert into t_results (who, test, actual, expected) values
  ('ledger', 'cannot change the amount of a HELD row either', pg_temp.try($q$update public.credit_ledger set delta = -1 where idempotency_key = 'test:r3'$q$), 'err:42501'),
  ('ledger', 'cannot rewrite the reason of a held row', pg_temp.try($q$update public.credit_ledger set reason = 'tampered' where idempotency_key = 'test:r3'$q$), 'err:42501');
select public.credit_release((select v from t_ids where k = 'r3'));
insert into t_results (who, test, actual, expected) values
  ('ledger', 'cannot change the amount of a committed row', pg_temp.try($q$update public.credit_ledger set delta = 999 where idempotency_key = 'test:r1'$q$), 'err:42501'),
  ('ledger', 'cannot move committed -> held', pg_temp.try($q$update public.credit_ledger set status = 'held' where idempotency_key = 'test:r1'$q$), 'err:PM003'),
  ('ledger', 'cannot delete a ledger row directly', pg_temp.try($q$delete from public.credit_ledger where idempotency_key = 'test:r1'$q$), 'err:42501');

-- ===========================================================================
-- 0.5 EVENTS + AUDIT
-- ===========================================================================
insert into t_results (who, test, actual, expected) values
  ('events', 'A: signup + email_verified emitted by triggers',
     (select string_agg(name, ',' order by id) from public.events where workspace_id = pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')), 'signup,email_verified'),
  ('events', 'C (confirmed in this test): signup then email_verified',
     (select string_agg(name, ',' order by id) from public.events where workspace_id = pg_temp.ws('cccccccc-0000-0000-0000-000000000003')), 'signup,email_verified'),
  ('events', 'events carry no PII in props',
     (select count(*) from public.events where workspace_id in (select ws from t_ws) and props::text ilike '%@%')::text, '0');

insert into public.events (workspace_id, user_id, name, ts)
values (pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 'aaaaaaaa-0000-0000-0000-000000000001', 'old_test_event', now() - interval '40 days');

create temp table t_purge as select public.purge_old_events(30) as n;
insert into t_results (who, test, actual, expected) values
  ('events', 'purge_old_events(30) removes the 40-day-old row and keeps recent ones',
     (select (n >= 1)::text from t_purge) || '/' ||
     (select count(*) from public.events where workspace_id = pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001') and name = 'old_test_event') || '/' ||
     (select count(*) from public.events where workspace_id = pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001') and name = 'signup'), 'true/0/1');
insert into t_results (who, test, actual, expected) values
  ('events', 'purge_old_events(5) refused (min retention 14 days)', pg_temp.try($q$select public.purge_old_events(5)$q$), 'err:22023');

insert into public.admin_audit (admin_id, action, target_type, target_id, diff, ip)
values ('bbbbbbbb-0000-0000-0000-000000000002', 'test_action', 'workspace', pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')::text, '{"k":1}', '127.0.0.1');
insert into t_results (who, test, actual, expected) values
  ('audit', 'admin_audit UPDATE is blocked', pg_temp.try($q$update public.admin_audit set action = 'tampered' where action = 'test_action'$q$), 'err:42501'),
  ('audit', 'admin_audit DELETE is blocked', pg_temp.try($q$delete from public.admin_audit where action = 'test_action'$q$), 'err:42501');

-- ===========================================================================
-- 0.6 ADMIN SQL
-- ===========================================================================
insert into t_results (who, test, actual, expected) values
  ('admin', 'non-superadmin (A, role=user) cannot adjust credits -> 42501',
     pg_temp.try($q$select public.admin_credit_adjust('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 5, 'should not work', 'adm1')$q$), 'err:42501');

update public.profiles set role = 'superadmin' where user_id = 'bbbbbbbb-0000-0000-0000-000000000002';

insert into t_ids select 'adm', public.admin_credit_adjust('bbbbbbbb-0000-0000-0000-000000000002', pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 25, 'goodwill grant', 'adm2', '203.0.113.9');
insert into t_results (who, test, actual, expected) values
  ('admin', 'superadmin grant +25 works: balance 25/0', pg_temp.bal(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')), '25/0'),
  ('admin', 'grant wrote exactly one admin_audit row with delta/reason/ip/before/after',
     (select count(*) || '/' || min(action) || '/' || min(diff->>'delta') || '/' || min(diff->>'reason') || '/' || min(ip) || '/' || min(diff->>'available_before') || '/' || min(diff->>'available_after')
        from public.admin_audit where action = 'credit_grant' and target_id = pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')::text),
     '1/credit_grant/25/goodwill grant/203.0.113.9/0/25'),
  ('admin', 'replaying the same key: same ledger id, no new audit row, balance unchanged',
     (public.admin_credit_adjust('bbbbbbbb-0000-0000-0000-000000000002', pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 25, 'goodwill grant', 'adm2', '203.0.113.9') = (select v from t_ids where k = 'adm'))::text || '/' ||
     (select count(*) from public.admin_audit where action = 'credit_grant' and target_id = pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')::text) || '/' ||
     pg_temp.bal(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')), 'true/1/25/0'),
  ('admin', 'reason shorter than 3 chars -> 22023',
     pg_temp.try($q$select public.admin_credit_adjust('bbbbbbbb-0000-0000-0000-000000000002', pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 5, 'x', 'adm4')$q$), 'err:22023'),
  ('admin', 'revoke below zero -> PM001 and nothing audited',
     pg_temp.try($q$select public.admin_credit_adjust('bbbbbbbb-0000-0000-0000-000000000002', pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), -9999, 'too much', 'adm5')$q$) || '/' ||
     (select count(*) from public.admin_audit where target_id = pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')::text and diff->>'reason' = 'too much'), 'err:PM001/0'),
  ('admin', 'admin_user_overview treats % in search as a literal (no wildcard abuse)',
     (select count(*)::text from public.admin_user_overview('%', 50, 0)), '0');

insert into t_ids select 'rev', public.admin_credit_adjust('bbbbbbbb-0000-0000-0000-000000000002', pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), -5, 'correction', 'adm3');
insert into t_results (who, test, actual, expected) values
  ('admin', 'revoke -5 works and is logged as credit_revoke (balance 20/0)',
     (select count(*) from public.admin_audit where action = 'credit_revoke' and target_id = pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')::text) || '/' ||
     pg_temp.bal(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')), '1/20/0'),
  ('admin', 'admin_user_overview(search) finds A with email, role and balance',
     (select count(*) || '/' || min(email) || '/' || min(role) || '/' || min(credits_available)
        from public.admin_user_overview('a@example.test', 50, 0)), '1/a@example.test/user/20');

-- ===========================================================================
-- PERMISSIONS as the real client roles
-- ===========================================================================
create temp table t_exp as
  select (select count(*) from public.credit_ledger where workspace_id = pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'))::text as a_rows;
grant select on t_exp to authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
set role authenticated;

insert into t_results (who, test, actual, expected) values
  ('A', 'sees exactly its own ledger rows (A+B workspaces queried; B rows hidden)',
     (select count(*)::text from public.credit_ledger where workspace_id in (select ws from t_ws)), (select a_rows from t_exp)),
  ('A', 'cannot read B''s ledger rows',
     (select count(*)::text from public.credit_ledger where workspace_id = pg_temp.ws('bbbbbbbb-0000-0000-0000-000000000002')), '0'),
  ('A', 'cannot call credit_reserve', pg_temp.try($q$select public.credit_reserve(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 1, 'x', 'client:r')$q$), 'err:42501'),
  ('A', 'cannot call credit_commit', pg_temp.try($q$select public.credit_commit(gen_random_uuid())$q$), 'err:42501'),
  ('A', 'cannot call credit_release', pg_temp.try($q$select public.credit_release(gen_random_uuid())$q$), 'err:42501'),
  ('A', 'cannot call credit_adjust (self-grant)', pg_temp.try($q$select public.credit_adjust(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 1000, 'self grant', 'client:g')$q$), 'err:42501'),
  ('A', 'cannot call credit_balance', pg_temp.try($q$select * from public.credit_balance(pg_temp.ws('bbbbbbbb-0000-0000-0000-000000000002'))$q$), 'err:42501'),
  ('A', 'cannot call grant_trial', pg_temp.try($q$select public.grant_trial(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 'a@example.test')$q$), 'err:42501'),
  ('A', 'cannot call admin_credit_adjust', pg_temp.try($q$select public.admin_credit_adjust('aaaaaaaa-0000-0000-0000-000000000001', pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 5, 'nope nope', 'client:a')$q$), 'err:42501'),
  ('A', 'cannot call admin_user_overview', pg_temp.try($q$select * from public.admin_user_overview(null, 5, 0)$q$), 'err:42501'),
  ('A', 'cannot call purge_old_events', pg_temp.try($q$select public.purge_old_events(30)$q$), 'err:42501'),
  ('A', 'cannot INSERT into credit_ledger', pg_temp.try($q$insert into public.credit_ledger (workspace_id, delta, reason, idempotency_key, status) values (pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 999, 'x', 'client:i', 'committed')$q$), 'err:42501'),
  ('A', 'cannot UPDATE credit_ledger', pg_temp.try($q$update public.credit_ledger set delta = 999$q$), 'err:42501'),
  ('A', 'cannot DELETE credit_ledger', pg_temp.try($q$delete from public.credit_ledger$q$), 'err:42501'),
  ('A', 'cannot read events', pg_temp.try($q$select count(*) from public.events$q$), 'err:42501'),
  ('A', 'cannot write events', pg_temp.try($q$insert into public.events (workspace_id, name) values (pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 'fake')$q$), 'err:42501'),
  ('A', 'cannot read admin_audit', pg_temp.try($q$select count(*) from public.admin_audit$q$), 'err:42501'),
  ('A', 'cannot write admin_audit', pg_temp.try($q$insert into public.admin_audit (action, target_type) values ('fake', 'x')$q$), 'err:42501');

-- B is a superadmin ROLE in profiles, but that grants no SQL-level powers to the client role
reset role;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-000000000002', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('B (superadmin in profiles)', 'still cannot read A''s ledger via the client role',
     (select count(*)::text from public.credit_ledger where workspace_id = pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')), '0'),
  ('B (superadmin in profiles)', 'still cannot call admin_credit_adjust via the client role',
     pg_temp.try($q$select public.admin_credit_adjust('bbbbbbbb-0000-0000-0000-000000000002', pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 5, 'abuse attempt', 'client:b')$q$), 'err:42501'),
  ('B (superadmin in profiles)', 'cannot self-assign roles',
     pg_temp.try($q$update public.profiles set role = 'superadmin' where user_id = 'bbbbbbbb-0000-0000-0000-000000000002'$q$), 'err:42501');

-- anon
reset role;
select set_config('request.jwt.claims', '', false);
select set_config('request.jwt.claim.sub', '', false);
set role anon;
insert into t_results (who, test, actual, expected) values
  ('anon', 'cannot read credit_ledger', pg_temp.try($q$select count(*) from public.credit_ledger$q$), 'err:42501'),
  ('anon', 'cannot read events', pg_temp.try($q$select count(*) from public.events$q$), 'err:42501'),
  ('anon', 'cannot read admin_audit', pg_temp.try($q$select count(*) from public.admin_audit$q$), 'err:42501'),
  ('anon', 'cannot call credit_adjust', pg_temp.try($q$select public.credit_adjust(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 5, 'x', 'anon:g')$q$), 'err:42501');

-- service_role: the server's identity can use the API
reset role;
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('service_role', 'can reserve + release through the function API',
     pg_temp.try($q$select public.credit_release(public.credit_reserve(pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001'), 1, 'x', 'svc:r'))$q$), 'ok'),
  ('service_role', 'can call admin_user_overview',
     pg_temp.try($q$select * from public.admin_user_overview(null, 5, 0)$q$), 'ok'),
  ('service_role', 'can purge events', pg_temp.try($q$select public.purge_old_events(30)$q$), 'ok');

-- ---------------------------------------------------------------------------
-- Cleanup (audit rows are append-only: lift the guard for the test rows only) + cascade check
-- ---------------------------------------------------------------------------
reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where target_id = pg_temp.ws('aaaaaaaa-0000-0000-0000-000000000001')::text;
alter table public.admin_audit enable trigger admin_audit_guard_del;

delete from auth.users where id in (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003');

insert into t_results (who, test, actual, expected)
select 'cleanup', 'users, workspaces, ledger rows and events removed by cascade (account deletion works)',
       (select count(*) from public.workspaces where id in (select ws from t_ws)) || '/' ||
       (select count(*) from public.credit_ledger where workspace_id in (select ws from t_ws)) || '/' ||
       (select count(*) from public.events where workspace_id in (select ws from t_ws)), '0/0/0';

select who, test, actual, expected, pass
from (
  select n as k, who, test, actual, expected, (actual = expected) as pass from t_results
  union all
  select 1000000, 'ALL CHECKS',
         (count(*) filter (where actual = expected))::text || ' of ' || count(*)::text || ' passed',
         '', '', bool_and(actual = expected)
  from t_results
) s
order by k;
