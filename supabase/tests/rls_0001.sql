-- rls_0001.sql — RLS + signup-trigger test for migration 0001
--
-- How to run: Supabase SQL Editor → paste whole file → Run (after 0001 is applied).
-- It creates 3 throw-away users (fixed UUIDs), impersonates them via the `authenticated`
-- / `anon` roles, records every check in a temp table, deletes the users again, and ends
-- with ONE result table. Safe to re-run; it removes leftovers from earlier runs first.
--
-- EXPECTED OUTPUT: 36 rows (35 checks + summary), every row has pass = true, last row is
--   ALL CHECKS  |  35 of 35 passed  |  (blank) | (blank) | true
-- Any `false` row = a real RLS/trigger bug → do not ship; send me the table.
--
-- Users: A = aaaaaaaa-…  (confirmed), B = bbbbbbbb-… (confirmed), C = cccccccc-… (unconfirmed)

reset role;

-- leftovers from an earlier run
delete from auth.users where id in (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003');

drop table if exists pg_temp.rls_results;
create temp table rls_results (
  n       serial,
  who     text,
  test    text,
  actual  text,
  expected text
);
grant all on rls_results to anon, authenticated;
grant usage on sequence rls_results_n_seq to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Setup (as postgres): A, B confirmed at signup; C unconfirmed
-- ---------------------------------------------------------------------------
insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('aaaaaaaa-0000-0000-0000-000000000001','authenticated','authenticated','a@example.test', now()),
  ('bbbbbbbb-0000-0000-0000-000000000002','authenticated','authenticated','b@example.test', now()),
  ('cccccccc-0000-0000-0000-000000000003','authenticated','authenticated','c@example.test', null);

-- Signup trigger checks (as postgres)
insert into rls_results (who, test, actual, expected)
select 'trigger', 'each new user got profile + workspace + owner membership (3 users)',
       (select count(*) from public.profiles p
          join public.workspaces w on w.owner_id = p.user_id
          join public.workspace_members m on m.workspace_id = w.id and m.user_id = p.user_id and m.role = 'owner'
         where p.user_id in ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000002','cccccccc-0000-0000-0000-000000000003'))::text,
       '3';

insert into rls_results (who, test, actual, expected)
select 'trigger', 'confirmed users A,B got a trial of 30 credits',
       (select count(*) from public.trials t join public.workspaces w on w.id = t.workspace_id
         where w.owner_id in ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000002')
           and t.granted_credits = 30)::text,
       '2';

insert into rls_results (who, test, actual, expected)
select 'trigger', 'unconfirmed user C has NO trial yet',
       (select count(*) from public.trials t join public.workspaces w on w.id = t.workspace_id
         where w.owner_id = 'cccccccc-0000-0000-0000-000000000003')::text,
       '0';

update auth.users set email_confirmed_at = now() where id = 'cccccccc-0000-0000-0000-000000000003';

insert into rls_results (who, test, actual, expected)
select 'trigger', 'after C confirms email, C gets exactly 1 trial of 30',
       (select count(*) || '/' || coalesce(max(t.granted_credits), 0) from public.trials t join public.workspaces w on w.id = t.workspace_id
         where w.owner_id = 'cccccccc-0000-0000-0000-000000000003'),
       '1/30';

-- confirming again must not double-grant (trigger fires only on NULL → value; PK blocks dupes anyway)
update auth.users set email_confirmed_at = now() + interval '1 minute' where id = 'cccccccc-0000-0000-0000-000000000003';
insert into rls_results (who, test, actual, expected)
select 'trigger', 're-confirm does not create a second trial for C',
       (select count(*) from public.trials t join public.workspaces w on w.id = t.workspace_id
         where w.owner_id = 'cccccccc-0000-0000-0000-000000000003')::text,
       '1';

-- ---------------------------------------------------------------------------
-- User A (authenticated)
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
set role authenticated;

insert into rls_results (who, test, actual, expected) values
  ('A', 'sees only own profile (count)',
        (select count(*) from public.profiles where user_id in ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000002','cccccccc-0000-0000-0000-000000000003'))::text, '1'),
  ('A', 'cannot read B''s profile',
        (select count(*) from public.profiles where user_id = 'bbbbbbbb-0000-0000-0000-000000000002')::text, '0'),
  ('A', 'sees only own workspace (count)',
        (select count(*) from public.workspaces where owner_id in ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000002'))::text, '1'),
  ('A', 'cannot read B''s workspace',
        (select count(*) from public.workspaces where owner_id = 'bbbbbbbb-0000-0000-0000-000000000002')::text, '0'),
  ('A', 'sees only own membership rows',
        (select count(*) from public.workspace_members where user_id in ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000002'))::text, '1'),
  ('A', 'cannot read B''s membership',
        (select count(*) from public.workspace_members where user_id = 'bbbbbbbb-0000-0000-0000-000000000002')::text, '0'),
  ('A', 'sees own trial (30 credits)',
        (select count(*) || '/' || coalesce(max(granted_credits), 0) from public.trials), '1/30'),
  ('A', 'cannot read B''s trial (direct filter on B''s email hash)',
        (select count(*) from public.trials where email_hash = encode(sha256(convert_to('b@example.test', 'utf8')), 'hex'))::text, '0'),
  ('A', 'sees both languages (es, en)',
        (select string_agg(code, ',' order by code) from public.languages), 'en,es');

-- writes that must silently affect 0 rows (RLS filters them out)
with u as (update public.workspaces set name = 'hacked' where owner_id = 'bbbbbbbb-0000-0000-0000-000000000002' returning 1)
insert into rls_results (who, test, actual, expected) select 'A', 'cannot rename B''s workspace (0 rows updated)', count(*)::text, '0' from u;

with u as (update public.profiles set locale = 'xx' where user_id = 'bbbbbbbb-0000-0000-0000-000000000002' returning 1)
insert into rls_results (who, test, actual, expected) select 'A', 'cannot edit B''s profile (0 rows updated)', count(*)::text, '0' from u;

-- positive: A may rename own workspace and set own locale
with u as (update public.workspaces set name = 'A workspace' where owner_id = 'aaaaaaaa-0000-0000-0000-000000000001' returning 1)
insert into rls_results (who, test, actual, expected) select 'A', 'can rename own workspace (1 row)', count(*)::text, '1' from u;

with u as (update public.profiles set locale = 'es-MX' where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' returning 1)
insert into rls_results (who, test, actual, expected) select 'A', 'can set own locale (1 row)', count(*)::text, '1' from u;

-- writes that must be rejected with "permission denied"
do $$
declare r text;
begin
  begin update public.profiles set role = 'superadmin' where user_id = 'aaaaaaaa-0000-0000-0000-000000000001'; r := 'allowed';
  exception when insufficient_privilege then r := 'denied'; end;
  insert into rls_results (who, test, actual, expected) values ('A', 'cannot escalate own role to superadmin', r, 'denied');

  begin update public.profiles set suspended = false where user_id = 'aaaaaaaa-0000-0000-0000-000000000001'; r := 'allowed';
  exception when insufficient_privilege then r := 'denied'; end;
  insert into rls_results (who, test, actual, expected) values ('A', 'cannot edit own suspended flag', r, 'denied');

  begin update public.workspaces set owner_id = 'bbbbbbbb-0000-0000-0000-000000000002' where owner_id = 'aaaaaaaa-0000-0000-0000-000000000001'; r := 'allowed';
  exception when insufficient_privilege then r := 'denied'; end;
  insert into rls_results (who, test, actual, expected) values ('A', 'cannot change workspace owner_id', r, 'denied');

  begin insert into public.workspaces (name, owner_id) values ('mine', 'aaaaaaaa-0000-0000-0000-000000000001'); r := 'allowed';
  exception when insufficient_privilege then r := 'denied'; end;
  insert into rls_results (who, test, actual, expected) values ('A', 'cannot insert a workspace directly', r, 'denied');

  begin insert into public.workspace_members (workspace_id, user_id, role)
        select id, 'aaaaaaaa-0000-0000-0000-000000000001', 'owner' from public.workspaces limit 1; r := 'allowed';
  exception when insufficient_privilege then r := 'denied'; end;
  insert into rls_results (who, test, actual, expected) values ('A', 'cannot insert a membership (self-join)', r, 'denied');

  begin delete from public.workspaces where owner_id = 'bbbbbbbb-0000-0000-0000-000000000002'; r := 'allowed';
  exception when insufficient_privilege then r := 'denied'; end;
  insert into rls_results (who, test, actual, expected) values ('A', 'cannot delete workspaces', r, 'denied');

  begin insert into public.trials (workspace_id, granted_credits, email_hash)
        select id, 9999, 'x' from public.workspaces limit 1; r := 'allowed';
  exception when insufficient_privilege then r := 'denied'; end;
  insert into rls_results (who, test, actual, expected) values ('A', 'cannot grant itself trial credits', r, 'denied');

  begin update public.trials set granted_credits = 9999; r := 'allowed';
  exception when insufficient_privilege then r := 'denied'; end;
  insert into rls_results (who, test, actual, expected) values ('A', 'cannot edit trial credits', r, 'denied');

  begin insert into public.languages (code, locale, name) values ('fr', 'fr-FR', 'Français'); r := 'allowed';
  exception when insufficient_privilege then r := 'denied'; end;
  insert into rls_results (who, test, actual, expected) values ('A', 'cannot insert languages', r, 'denied');
end $$;

-- ---------------------------------------------------------------------------
-- User B: symmetric spot-check
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-000000000002', false);
set role authenticated;

insert into rls_results (who, test, actual, expected) values
  ('B', 'cannot read A''s profile',
        (select count(*) from public.profiles where user_id = 'aaaaaaaa-0000-0000-0000-000000000001')::text, '0'),
  ('B', 'cannot read A''s workspace (and A''s rename is invisible)',
        (select count(*) from public.workspaces where owner_id = 'aaaaaaaa-0000-0000-0000-000000000001')::text, '0');

-- ---------------------------------------------------------------------------
-- anon (not logged in)
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '', false);
select set_config('request.jwt.claim.sub', '', false);
set role anon;

do $$
declare r text;
begin
  begin perform 1 from public.profiles limit 1; r := 'allowed';
  exception when insufficient_privilege then r := 'denied'; end;
  insert into rls_results (who, test, actual, expected) values ('anon', 'cannot read profiles', r, 'denied');

  begin perform 1 from public.workspaces limit 1; r := 'allowed';
  exception when insufficient_privilege then r := 'denied'; end;
  insert into rls_results (who, test, actual, expected) values ('anon', 'cannot read workspaces', r, 'denied');

  begin perform 1 from public.workspace_members limit 1; r := 'allowed';
  exception when insufficient_privilege then r := 'denied'; end;
  insert into rls_results (who, test, actual, expected) values ('anon', 'cannot read workspace_members', r, 'denied');

  begin perform 1 from public.trials limit 1; r := 'allowed';
  exception when insufficient_privilege then r := 'denied'; end;
  insert into rls_results (who, test, actual, expected) values ('anon', 'cannot read trials', r, 'denied');
end $$;

insert into rls_results (who, test, actual, expected)
select 'anon', 'can read languages (public reference data)', count(*)::text, '2' from public.languages;

-- ---------------------------------------------------------------------------
-- Cleanup + final result (must be the last statement so the Editor shows it)
-- ---------------------------------------------------------------------------
reset role;
delete from auth.users where id in (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003');

insert into rls_results (who, test, actual, expected)
select 'cleanup', 'test users and their cascaded rows removed',
       (select count(*) from public.profiles where user_id in ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000002','cccccccc-0000-0000-0000-000000000003'))::text
       || '/' ||
       (select count(*) from public.workspaces where owner_id in ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000002','cccccccc-0000-0000-0000-000000000003'))::text,
       '0/0';

select who, test, actual, expected, pass
from (
  select n as k, who, test, actual, expected, (actual = expected) as pass
  from rls_results
  union all
  select 1000000, 'ALL CHECKS',
         (count(*) filter (where actual = expected))::text || ' of ' || count(*)::text || ' passed',
         '', '', bool_and(actual = expected)
  from rls_results
) s
order by k;
