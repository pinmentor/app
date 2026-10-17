-- rls_0007.sql — tests for migration 0007 (platform_secrets: encrypted provider keys, superadmin-only writes, audit)
--
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0007 is applied). Safe to re-run.
-- It creates 3 throw-away users (A = user, B = superadmin, C = support) and uses ONLY the providers 'dataforseo' and
-- 'gemini'. Whatever is stored for those two providers before the test is snapshotted and put back byte-for-byte at the
-- end. Do not run it while a Gemini call is in flight (for a split second the stored key is the test value).
--
-- EXPECTED OUTPUT: every row pass = true; last row  ALL CHECKS | <N> of <N> passed | (blank) | (blank) | true
-- Any `false` row = a real bug -> do not use the key page; send me the table.

reset role;

alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in (
  'a7a7a7a7-0000-0000-0000-000000000001','b7b7b7b7-0000-0000-0000-000000000002','c7c7c7c7-0000-0000-0000-000000000003');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in (
  'a7a7a7a7-0000-0000-0000-000000000001','b7b7b7b7-0000-0000-0000-000000000002','c7c7c7c7-0000-0000-0000-000000000003');

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;

create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

-- snapshot of whatever is really stored for the two providers this test uses
create temp table t_snap as select * from public.platform_secrets where provider in ('dataforseo', 'gemini');
delete from public.platform_secrets where provider in ('dataforseo', 'gemini');

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('a7a7a7a7-0000-0000-0000-000000000001','authenticated','authenticated','a7@example.test', now()),
  ('b7b7b7b7-0000-0000-0000-000000000002','authenticated','authenticated','b7@example.test', now()),
  ('c7c7c7c7-0000-0000-0000-000000000003','authenticated','authenticated','c7@example.test', now());
update public.profiles set role = 'superadmin' where user_id = 'b7b7b7b7-0000-0000-0000-000000000002';
update public.profiles set role = 'support'    where user_id = 'c7c7c7c7-0000-0000-0000-000000000003';

-- ===========================================================================
-- Permissions as the real client roles
-- ===========================================================================
select set_config('request.jwt.claims', '{"sub":"a7a7a7a7-0000-0000-0000-000000000001","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'a7a7a7a7-0000-0000-0000-000000000001', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('A', 'cannot read platform_secrets', pg_temp.try($q$select count(*) from public.platform_secrets$q$), 'err:42501'),
  ('A', 'cannot insert / update / delete platform_secrets',
     pg_temp.try($q$insert into public.platform_secrets (provider, ciphertext, last4) values ('gemini', 'v1.aaaaaaaaaaaaaaaaaaaa', 'abcd')$q$) || '/' ||
     pg_temp.try($q$update public.platform_secrets set last4 = 'zzzz'$q$) || '/' ||
     pg_temp.try($q$delete from public.platform_secrets$q$), 'err:42501/err:42501/err:42501'),
  ('A', 'cannot call any secret function',
     pg_temp.try($q$select public.admin_secret_set('a7a7a7a7-0000-0000-0000-000000000001', 'gemini', 'v1.aaaaaaaaaaaaaaaaaaaa', 'abcd')$q$) || '/' ||
     pg_temp.try($q$select public.admin_secret_delete('a7a7a7a7-0000-0000-0000-000000000001', 'gemini')$q$) || '/' ||
     pg_temp.try($q$select public.admin_secret_record_test('a7a7a7a7-0000-0000-0000-000000000001', 'gemini', true, 'ok')$q$) || '/' ||
     pg_temp.try($q$select * from public.admin_secret_list()$q$) || '/' ||
     pg_temp.try($q$select public.secret_get_ciphertext('gemini')$q$), 'err:42501/err:42501/err:42501/err:42501/err:42501');

reset role;
set role anon;
insert into t_results (who, test, actual, expected) values
  ('anon', 'cannot read the table or call the functions',
     pg_temp.try($q$select count(*) from public.platform_secrets$q$) || '/' ||
     pg_temp.try($q$select public.secret_get_ciphertext('gemini')$q$) || '/' ||
     pg_temp.try($q$select * from public.admin_secret_list()$q$), 'err:42501/err:42501/err:42501');

-- ===========================================================================
-- service_role: role checks inside the functions
-- ===========================================================================
reset role;
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('A (user)', 'cannot set a key (SQL re-checks the role)',
     pg_temp.try($q$select public.admin_secret_set('a7a7a7a7-0000-0000-0000-000000000001', 'gemini', 'v1.aaaaaaaaaaaaaaaaaaaa', 'abcd')$q$), 'err:42501'),
  ('C (support)', 'cannot set / delete / record a test',
     pg_temp.try($q$select public.admin_secret_set('c7c7c7c7-0000-0000-0000-000000000003', 'gemini', 'v1.aaaaaaaaaaaaaaaaaaaa', 'abcd')$q$) || '/' ||
     pg_temp.try($q$select public.admin_secret_delete('c7c7c7c7-0000-0000-0000-000000000003', 'gemini')$q$) || '/' ||
     pg_temp.try($q$select public.admin_secret_record_test('c7c7c7c7-0000-0000-0000-000000000003', 'gemini', true, 'ok')$q$), 'err:42501/err:42501/err:42501'),
  ('unknown admin id', 'cannot set a key',
     pg_temp.try($q$select public.admin_secret_set(gen_random_uuid(), 'gemini', 'v1.aaaaaaaaaaaaaaaaaaaa', 'abcd')$q$), 'err:42501'),
  ('nothing written', 'refused calls left the table empty',
     (select count(*)::text from public.platform_secrets where provider in ('dataforseo', 'gemini')), '0');

-- B (superadmin): the happy path
select public.admin_secret_set('b7b7b7b7-0000-0000-0000-000000000002', 'gemini', 'v1.FIRSTCIPHERTEXTxxxxxxxx.tag.ct', 'wxyz', '203.0.113.9');
insert into t_results (who, test, actual, expected) values
  ('B (superadmin)', 'set stores the row with last4 and set_by',
     (select provider || '/' || last4 || '/' || (set_by = 'b7b7b7b7-0000-0000-0000-000000000002') from public.platform_secrets where provider = 'gemini'), 'gemini/wxyz/true'),
  ('B (superadmin)', 'resolver read returns exactly the stored ciphertext',
     public.secret_get_ciphertext('gemini'), 'v1.FIRSTCIPHERTEXTxxxxxxxx.tag.ct'),
  ('B (superadmin)', 'resolver read returns NULL for a provider with no key',
     coalesce(public.secret_get_ciphertext('dataforseo'), 'NULL'), 'NULL'),
  ('B (superadmin)', 'audit row secret_set with provider + last4 + ip',
     (select action || '/' || (diff ->> 'provider') || '/' || (diff ->> 'last4') || '/' || ip from public.admin_audit
       where admin_id = 'b7b7b7b7-0000-0000-0000-000000000002' and target_type = 'platform_secret' order by at desc limit 1),
     'secret_set/gemini/wxyz/203.0.113.9');

-- test record + replace resets the test status
select public.admin_secret_record_test('b7b7b7b7-0000-0000-0000-000000000002', 'gemini', false, 'http_401');
insert into t_results (who, test, actual, expected) values
  ('B (superadmin)', 'record_test stores outcome and code',
     (select last_test_ok || '/' || last_test_code || '/' || (last_tested_at is not null) from public.platform_secrets where provider = 'gemini'), 'false/http_401/true');

select public.admin_secret_set('b7b7b7b7-0000-0000-0000-000000000002', 'gemini', 'v1.SECONDCIPHERTEXTxxxxxxx.tag.ct', 'abcd');
insert into t_results (who, test, actual, expected) values
  ('B (superadmin)', 'replace keeps one row, new ciphertext, test status reset',
     (select count(*) || '/' || max(last4) || '/' || coalesce(max(last_test_ok::text), 'NULL') from public.platform_secrets where provider = 'gemini'), '1/abcd/NULL'),
  ('B (superadmin)', 'audit row secret_replace records previous last4 only',
     (select action || '/' || (diff ->> 'previous_last4') || '/' || (diff ->> 'last4') from public.admin_audit
       where admin_id = 'b7b7b7b7-0000-0000-0000-000000000002' and action = 'secret_replace' order by at desc limit 1), 'secret_replace/wxyz/abcd'),
  ('B (superadmin)', 'list returns exactly these 7 columns (no ciphertext)',
     pg_get_function_result('public.admin_secret_list()'::regprocedure),
     'TABLE(provider text, last4 text, set_at timestamp with time zone, set_by_email text, last_tested_at timestamp with time zone, last_test_ok boolean, last_test_code text)'),
  ('B (superadmin)', 'list row has last4 + email',
     (select last4 || '/' || set_by_email from public.admin_secret_list() where provider = 'gemini'), 'abcd/b7@example.test'),
  ('B (superadmin)', 'unknown provider rejected',
     pg_temp.try($q$select public.admin_secret_set('b7b7b7b7-0000-0000-0000-000000000002', 'acme', 'v1.aaaaaaaaaaaaaaaaaaaa', 'abcd')$q$), 'err:23514'),
  ('B (superadmin)', 'ciphertext that is not a v1 blob is rejected',
     pg_temp.try($q$select public.admin_secret_set('b7b7b7b7-0000-0000-0000-000000000002', 'dataforseo', 'sk-live-PLAINTEXTKEY-1234567890', '7890')$q$), 'err:23514'),
  ('B (superadmin)', 'last4 must be exactly 4 characters',
     pg_temp.try($q$select public.admin_secret_set('b7b7b7b7-0000-0000-0000-000000000002', 'dataforseo', 'v1.aaaaaaaaaaaaaaaaaaaa', 'abc')$q$), 'err:23514');

-- delete
insert into t_results (who, test, actual, expected) values
  ('B (superadmin)', 'delete returns true, then false when already gone',
     public.admin_secret_delete('b7b7b7b7-0000-0000-0000-000000000002', 'gemini')::text || '/' ||
     public.admin_secret_delete('b7b7b7b7-0000-0000-0000-000000000002', 'gemini')::text, 'true/false');
insert into t_results (who, test, actual, expected) values
  ('B (superadmin)', 'delete is audited exactly once',
     (select count(*)::text from public.admin_audit where admin_id = 'b7b7b7b7-0000-0000-0000-000000000002' and action = 'secret_delete'), '1'),
  ('audit', 'no audit row of this feature contains key material (v1. blob) or the word ciphertext',
     (select count(*)::text from public.admin_audit where target_type = 'platform_secret'
        and (diff::text like '%v1.%' or diff::text ilike '%ciphertext%')), '0'),
  ('audit', 'audit rows written: set, replace, test, delete = 4',
     (select count(*)::text from public.admin_audit where admin_id = 'b7b7b7b7-0000-0000-0000-000000000002' and target_type = 'platform_secret'), '4');

-- ---------------------------------------------------------------------------
-- Cleanup: remove test rows, restore the real keys byte-for-byte
-- ---------------------------------------------------------------------------
reset role;
delete from public.platform_secrets where provider in ('dataforseo', 'gemini');
insert into public.platform_secrets select * from t_snap;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in (
  'a7a7a7a7-0000-0000-0000-000000000001','b7b7b7b7-0000-0000-0000-000000000002','c7c7c7c7-0000-0000-0000-000000000003');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in (
  'a7a7a7a7-0000-0000-0000-000000000001','b7b7b7b7-0000-0000-0000-000000000002','c7c7c7c7-0000-0000-0000-000000000003');

insert into t_results (who, test, actual, expected)
select 'cleanup', 'test users and audit rows gone; stored keys for the two providers restored exactly',
       (select count(*) from auth.users where id::text like '%7a7a7a7-%' or id::text like '%7b7b7b7-%' or id::text like '%7c7c7c7-%') || '/' ||
       (select count(*) from public.admin_audit where target_type = 'platform_secret' and diff ->> 'provider' in ('gemini','dataforseo') and ip = '203.0.113.9') || '/' ||
       (select count(*) from public.platform_secrets p join t_snap s using (provider) where p.ciphertext = s.ciphertext and p.last4 = s.last4)
         || '=' || (select count(*) from t_snap),
       '0/0/' || (select count(*) from t_snap) || '=' || (select count(*) from t_snap);

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
