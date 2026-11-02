-- rls_0026.sql — tests for migration 0026 (site language/locale/CTA, workspace review language)
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0021-0026 are applied). Safe to re-run.
-- Runs as ONE transaction on Supabase; nothing here depends on now() ordering.
-- EXPECTED OUTPUT: every row pass = true; last row  ALL CHECKS | <N> of <N> passed | (blank) | (blank) | true

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a2610101-0000-0000-0000-000000000001','b2610101-0000-0000-0000-000000000002','c2610101-0000-0000-0000-000000000003');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a2610101-0000-0000-0000-000000000001','b2610101-0000-0000-0000-000000000002','c2610101-0000-0000-0000-000000000003');

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('a2610101-0000-0000-0000-000000000001','authenticated','authenticated','a26@example.test', now()),
  ('b2610101-0000-0000-0000-000000000002','authenticated','authenticated','b26@example.test', now()),
  ('c2610101-0000-0000-0000-000000000003','authenticated','authenticated','c26@example.test', now());
create temp table t_ws as select owner_id as uid, id as ws from public.workspaces
  where owner_id in ('a2610101-0000-0000-0000-000000000001','b2610101-0000-0000-0000-000000000002');
grant select on t_ws to anon, authenticated, service_role;
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to anon, authenticated, service_role;
create temp table t_calls (k text primary key, v text);
grant all on t_calls to anon, authenticated, service_role;
create function pg_temp.wsa() returns uuid language sql as $$ select ws from t_ws where uid = 'a2610101-0000-0000-0000-000000000001' $$;
create function pg_temp.wsb() returns uuid language sql as $$ select ws from t_ws where uid = 'b2610101-0000-0000-0000-000000000002' $$;
create function pg_temp.j(k text) returns uuid language sql as $$ select v from t_ids where k = $1 $$;
create function pg_temp.ua() returns uuid language sql as $$ select 'a2610101-0000-0000-0000-000000000001'::uuid $$;
create function pg_temp.ub() returns uuid language sql as $$ select 'b2610101-0000-0000-0000-000000000002'::uuid $$;
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

create function pg_temp.uc() returns uuid language sql as $$ select 'c2610101-0000-0000-0000-000000000003'::uuid $$;
grant execute on function pg_temp.uc() to anon, authenticated, service_role;

-- A owns a workspace and one site; C is only a plain member of A's workspace; B is a stranger
insert into public.workspace_members (workspace_id, user_id, role) values (pg_temp.wsa(), pg_temp.uc(), 'member');
insert into public.sites (workspace_id, name, base_url, wp_user, ciphertext, last4)
values (pg_temp.wsa(), 'test', 'https://t26.example.test', 'u', 'v1.' || repeat('x', 30), '1234');
insert into t_ids select 'site', id from public.sites where workspace_id = pg_temp.wsa();
insert into t_calls values ('defaults', (select language || '/' || locale || '/' || coalesce(cta_label, 'null') from public.sites where id = pg_temp.j('site')));
insert into t_calls values ('rl_default', (select review_language from public.workspaces where id = pg_temp.wsa()));

set role service_role;
insert into t_calls values ('s_ok', pg_temp.sql_try(format($q$select public.site_update_settings(%L, %L, 'en', 'en-US', '  Shop now  ')$q$, pg_temp.ua(), pg_temp.j('site'))));
reset role;
insert into t_calls values ('s_stored', (select language || '/' || locale || '/' || coalesce(cta_label, 'null') from public.sites where id = pg_temp.j('site')));
set role service_role;
insert into t_calls values ('s_stranger', pg_temp.sql_try(format($q$select public.site_update_settings(%L, %L, 'es', 'es-MX', null)$q$, pg_temp.ub(), pg_temp.j('site'))));
insert into t_calls values ('s_unknown_lang', pg_temp.sql_try(format($q$select public.site_update_settings(%L, %L, 'fr', 'fr-FR', null)$q$, pg_temp.ua(), pg_temp.j('site'))));
insert into t_calls values ('s_mismatch', pg_temp.sql_try(format($q$select public.site_update_settings(%L, %L, 'es', 'en-US', null)$q$, pg_temp.ua(), pg_temp.j('site'))));
insert into t_calls values ('s_badlocale', pg_temp.sql_try(format($q$select public.site_update_settings(%L, %L, 'es', 'xx', null)$q$, pg_temp.ua(), pg_temp.j('site'))));
insert into t_calls values ('s_longcta', pg_temp.sql_try(format($q$select public.site_update_settings(%L, %L, 'es', 'es-MX', %L)$q$, pg_temp.ua(), pg_temp.j('site'), repeat('x', 61))));
insert into t_calls values ('s_nosite', pg_temp.sql_try(format($q$select public.site_update_settings(%L, gen_random_uuid(), 'es', 'es-MX', null)$q$, pg_temp.ua())));
reset role;
insert into t_calls values ('s_unchanged', (select language || '/' || locale || '/' || coalesce(cta_label, 'null') from public.sites where id = pg_temp.j('site')));
set role service_role;
insert into t_calls values ('s_member_ok', pg_temp.sql_try(format($q$select public.site_update_settings(%L, %L, 'es', 'es-MX', '   ')$q$, pg_temp.uc(), pg_temp.j('site'))));
reset role;
insert into t_calls values ('s_blank_cta', (select language || '/' || locale || '/' || coalesce(cta_label, 'null') from public.sites where id = pg_temp.j('site')));

set role service_role;
insert into t_calls values ('r_member', pg_temp.sql_try(format($q$select public.workspace_set_review_language(%L, %L, 'en')$q$, pg_temp.uc(), pg_temp.wsa())));
insert into t_calls values ('r_stranger', pg_temp.sql_try(format($q$select public.workspace_set_review_language(%L, %L, 'en')$q$, pg_temp.ub(), pg_temp.wsa())));
insert into t_calls values ('r_bad', pg_temp.sql_try(format($q$select public.workspace_set_review_language(%L, %L, 'fr')$q$, pg_temp.ua(), pg_temp.wsa())));
reset role;
insert into t_calls values ('r_after_refusals', (select review_language from public.workspaces where id = pg_temp.wsa()));
set role service_role;
insert into t_calls values ('r_owner', pg_temp.sql_try(format($q$select public.workspace_set_review_language(%L, %L, 'en')$q$, pg_temp.ua(), pg_temp.wsa())));
reset role;
insert into t_calls values ('r_stored', (select review_language from public.workspaces where id = pg_temp.wsa()));

insert into t_results (who, test, actual, expected) values
  ('service', 'a new site defaults to es / es-MX / no CTA', (select v from t_calls where k = 'defaults'), 'es/es-MX/null'),
  ('service', 'a workspace defaults to Bengali review', (select v from t_calls where k = 'rl_default'), 'bn'),
  ('service', 'a member updates language, locale and CTA', (select v from t_calls where k = 's_ok'), 'ok'),
  ('service', 'the CTA is trimmed and stored', (select v from t_calls where k = 's_stored'), 'en/en-US/Shop now'),
  ('service', 'a non-member cannot change a site (42501)', (select v from t_calls where k = 's_stranger'), 'err:42501'),
  ('service', 'an unknown language is refused (22023)', (select v from t_calls where k = 's_unknown_lang'), 'err:22023'),
  ('service', 'a locale of another language is refused (22023)', (select v from t_calls where k = 's_mismatch'), 'err:22023'),
  ('service', 'a malformed locale is refused (22023)', (select v from t_calls where k = 's_badlocale'), 'err:22023'),
  ('service', 'a CTA over 60 characters is refused (22023)', (select v from t_calls where k = 's_longcta'), 'err:22023'),
  ('service', 'an unknown site is refused (P0002)', (select v from t_calls where k = 's_nosite'), 'err:P0002'),
  ('service', 'every refusal changed nothing', (select v from t_calls where k = 's_unchanged'), 'en/en-US/Shop now'),
  ('service', 'a plain member may change site settings', (select v from t_calls where k = 's_member_ok'), 'ok'),
  ('service', 'a blank CTA is stored as null', (select v from t_calls where k = 's_blank_cta'), 'es/es-MX/null'),
  ('service', 'a plain member cannot change the workspace review language (42501)', (select v from t_calls where k = 'r_member'), 'err:42501'),
  ('service', 'a non-member cannot change it (42501)', (select v from t_calls where k = 'r_stranger'), 'err:42501'),
  ('service', 'an unknown review language is refused (22023)', (select v from t_calls where k = 'r_bad'), 'err:22023'),
  ('service', 'refusals left it at bn', (select v from t_calls where k = 'r_after_refusals'), 'bn'),
  ('service', 'the owner changes it', (select v from t_calls where k = 'r_owner'), 'ok'),
  ('service', 'the new value is stored', (select v from t_calls where k = 'r_stored'), 'en');

select set_config('request.jwt.claims', '{"sub":"a2610101-0000-0000-0000-000000000001","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'a2610101-0000-0000-0000-000000000001', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('A', 'reads language, locale and cta_label of its own site', (select count(*)::text from public.sites where id = pg_temp.j('site') and language = 'es' and locale = 'es-MX' and cta_label is null), '1'),
  ('A', 'reads review_language of its own workspace', (select review_language from public.workspaces where id = pg_temp.wsa()), 'en'),
  ('A', 'cannot call site_update_settings (service only)', pg_temp.sql_try(format($q$select public.site_update_settings(%L, %L, 'es', 'es-MX', null)$q$, pg_temp.ua(), pg_temp.j('site'))), 'err:42501'),
  ('A', 'cannot call workspace_set_review_language (service only)', pg_temp.sql_try(format($q$select public.workspace_set_review_language(%L, %L, 'bn')$q$, pg_temp.ua(), pg_temp.wsa())), 'err:42501'),
  ('A', 'cannot write sites directly', pg_temp.sql_try($q$update public.sites set cta_label = 'x'$q$), 'err:42501'),
  ('A', 'cannot write review_language directly', pg_temp.sql_try($q$update public.workspaces set review_language = 'bn'$q$), 'err:42501');
reset role;
select set_config('request.jwt.claims', '{"sub":"b2610101-0000-0000-0000-000000000002","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'b2610101-0000-0000-0000-000000000002', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('B', 'cannot see A''s site', (select count(*)::text from public.sites where id = pg_temp.j('site')), '0'),
  ('B', 'cannot see A''s workspace', (select count(*)::text from public.workspaces where id = pg_temp.wsa()), '0');
reset role;
select set_config('request.jwt.claims', '{}', false);

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a2610101-0000-0000-0000-000000000001','b2610101-0000-0000-0000-000000000002','c2610101-0000-0000-0000-000000000003');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a2610101-0000-0000-0000-000000000001','b2610101-0000-0000-0000-000000000002','c2610101-0000-0000-0000-000000000003');

select n, who, test, actual, expected, (actual = expected) as pass from t_results
union all
select 9999, 'ALL CHECKS', (select count(*) filter (where actual = expected) from t_results)::text || ' of ' || (select count(*) from t_results)::text || ' passed', '', '',
       (select bool_and(actual = expected) from t_results)
order by 1;
