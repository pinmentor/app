-- 0007_platform_secrets.sql — PinMentor Batch 04
-- Platform API keys (LLM providers, SERP provider) added from /admin/integrations instead of Vercel env vars.
--
-- Rules this follows (CLAUDE.md): secrets never reach the client or logs; encrypted at rest; every admin action is audited.
--  * The key is encrypted IN THE APP (AES-256-GCM, master key = Vercel env ENCRYPTION_KEY) before it reaches the
--    database. The database only ever sees ciphertext, so a DB dump or SQL-editor screenshot never exposes a key.
--  * The table has RLS on and NO policies, and every grant is revoked from anon/authenticated. Only service_role (the
--    server) can touch it, through the functions below.
--  * Writes go through SECURITY DEFINER functions that re-check the caller's role (superadmin only) and write
--    admin_audit. The audit diff holds the provider and the last 4 characters, never the key or the ciphertext.
--  * Environment variables keep working as a fallback (the app looks in this table first, then env).
--
-- How to run: Supabase SQL Editor -> paste whole file -> Run, ONCE (it is not idempotent; a second run fails with 42P07).
-- Then run supabase/tests/rls_0007.sql; the last row must read:  ALL CHECKS | <N> of <N> passed | true

create table public.platform_secrets (
  provider       text primary key
                 check (provider in ('anthropic', 'openai', 'gemini', 'dataforseo')),
  -- "v1.<iv>.<tag>.<ciphertext>" (base64url). Opaque to SQL.
  ciphertext     text not null check (char_length(ciphertext) between 20 and 4000 and ciphertext like 'v1.%'),
  last4          text not null check (char_length(last4) = 4),
  set_by         uuid references auth.users (id) on delete set null,
  set_at         timestamptz not null default now(),
  last_tested_at timestamptz,
  last_test_ok   boolean,
  last_test_code text check (last_test_code is null or char_length(last_test_code) <= 60)
);

alter table public.platform_secrets enable row level security;   -- no policies: server-side access only
revoke all on public.platform_secrets from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Write: set / replace a key. Superadmin only.
-- ---------------------------------------------------------------------------
create function public.admin_secret_set(
  p_admin uuid, p_provider text, p_ciphertext text, p_last4 text, p_ip text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role   text;
  v_before text;
begin
  select p.role into v_role from public.profiles p where p.user_id = p_admin;
  if v_role is distinct from 'superadmin' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select s.last4 into v_before from public.platform_secrets s where s.provider = p_provider;

  insert into public.platform_secrets (provider, ciphertext, last4, set_by, set_at, last_tested_at, last_test_ok, last_test_code)
  values (p_provider, p_ciphertext, p_last4, p_admin, now(), null, null, null)
  on conflict (provider) do update
    set ciphertext = excluded.ciphertext, last4 = excluded.last4, set_by = excluded.set_by, set_at = now(),
        last_tested_at = null, last_test_ok = null, last_test_code = null;

  insert into public.admin_audit (admin_id, action, target_type, target_id, diff, ip)
  values (p_admin, case when v_before is null then 'secret_set' else 'secret_replace' end, 'platform_secret', p_provider,
          jsonb_build_object('provider', p_provider, 'last4', p_last4, 'previous_last4', v_before), p_ip);
end;
$$;

create function public.admin_secret_delete(p_admin uuid, p_provider text, p_ip text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role  text;
  v_last4 text;
begin
  select p.role into v_role from public.profiles p where p.user_id = p_admin;
  if v_role is distinct from 'superadmin' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  delete from public.platform_secrets s where s.provider = p_provider returning s.last4 into v_last4;
  if v_last4 is null then
    return false;
  end if;

  insert into public.admin_audit (admin_id, action, target_type, target_id, diff, ip)
  values (p_admin, 'secret_delete', 'platform_secret', p_provider,
          jsonb_build_object('provider', p_provider, 'last4', v_last4), p_ip);
  return true;
end;
$$;

-- Record the outcome of "Test connection" (no key material involved). Superadmin only, audited.
create function public.admin_secret_record_test(
  p_admin uuid, p_provider text, p_ok boolean, p_code text, p_ip text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  select p.role into v_role from public.profiles p where p.user_id = p_admin;
  if v_role is distinct from 'superadmin' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.platform_secrets
     set last_tested_at = now(), last_test_ok = p_ok, last_test_code = left(p_code, 60)
   where provider = p_provider;

  insert into public.admin_audit (admin_id, action, target_type, target_id, diff, ip)
  values (p_admin, 'secret_test', 'platform_secret', p_provider,
          jsonb_build_object('provider', p_provider, 'ok', p_ok, 'code', left(p_code, 60)), p_ip);
end;
$$;

-- ---------------------------------------------------------------------------
-- Read: list for the admin page (never returns ciphertext) and ciphertext for the server-side resolver.
-- ---------------------------------------------------------------------------
create function public.admin_secret_list()
returns table (provider text, last4 text, set_at timestamptz, set_by_email text,
               last_tested_at timestamptz, last_test_ok boolean, last_test_code text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.provider, s.last4, s.set_at, u.email::text, s.last_tested_at, s.last_test_ok, s.last_test_code
  from public.platform_secrets s
  left join auth.users u on u.id = s.set_by
  order by s.provider;
$$;

create function public.secret_get_ciphertext(p_provider text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.ciphertext from public.platform_secrets s where s.provider = p_provider;
$$;

revoke all on function public.admin_secret_set(uuid, text, text, text, text)            from public, anon, authenticated;
revoke all on function public.admin_secret_delete(uuid, text, text)                     from public, anon, authenticated;
revoke all on function public.admin_secret_record_test(uuid, text, boolean, text, text) from public, anon, authenticated;
revoke all on function public.admin_secret_list()                                       from public, anon, authenticated;
revoke all on function public.secret_get_ciphertext(text)                               from public, anon, authenticated;

grant execute on function public.admin_secret_set(uuid, text, text, text, text)            to service_role;
grant execute on function public.admin_secret_delete(uuid, text, text)                     to service_role;
grant execute on function public.admin_secret_record_test(uuid, text, boolean, text, text) to service_role;
grant execute on function public.admin_secret_list()                                       to service_role;
grant execute on function public.secret_get_ciphertext(text)                               to service_role;
