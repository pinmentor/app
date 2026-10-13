-- 0004_admin.sql
-- PinMentor Batch 01C, task 0.6 (database side): server-only helpers for the /admin skeleton.
-- Requires 0001-0003. Paste into Supabase SQL Editor and run once.
--
--  * admin_user_overview(): paged user list with workspace + credit balance (needs auth.users, so it
--    cannot be a plain client query). Execute = service_role only; the Next.js server calls it
--    AFTER its role guard + TOTP (aal2) check.
--  * admin_credit_adjust(): the ONLY path for a manual credit grant/revoke. Re-checks that the acting
--    user is a superadmin in the database, writes the ledger entry and the admin_audit row in the
--    same transaction, and is idempotent (replaying the same key changes nothing and logs nothing).
--
-- Making the first superadmin (once, in the SQL Editor — clients cannot change `profiles.role`):
--   update public.profiles set role = 'superadmin'
--   where user_id = (select id from auth.users where email = 'YOUR_EMAIL_HERE');

create function public.admin_user_overview(
  p_search text    default null,
  p_limit  integer default 50,
  p_offset integer default 0
)
returns table (
  user_id           uuid,
  email             text,
  role              text,
  suspended         boolean,
  created_at        timestamptz,
  last_sign_in_at   timestamptz,
  workspace_id      uuid,
  workspace_name    text,
  credits_available integer,
  credits_held      integer,
  total_count       bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    u.id,
    u.email::text,
    p.role,
    p.suspended,
    u.created_at,
    u.last_sign_in_at,
    w.id,
    w.name,
    coalesce(b.available, 0),
    coalesce(b.held, 0),
    count(*) over ()
  from auth.users u
  join public.profiles p on p.user_id = u.id
  left join lateral (
    select ws.id, ws.name
    from public.workspaces ws
    where ws.owner_id = u.id
    order by ws.created_at
    limit 1
  ) w on true
  left join lateral public.credit_balance(w.id) b on true
  where p_search is null
     or btrim(p_search) = ''
     or u.email ilike '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  order by u.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create function public.admin_credit_adjust(
  p_admin     uuid,
  p_workspace uuid,
  p_delta     integer,
  p_reason    text,
  p_key       text,
  p_ip        text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role    text;
  v_key     text;
  v_existed boolean;
  v_before  integer;
  v_after   integer;
  v_id      uuid;
begin
  select p.role into v_role from public.profiles p where p.user_id = p_admin;
  if v_role is distinct from 'superadmin' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_key is null or btrim(p_key) = '' then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;

  v_key := 'admin:' || p_key;

  -- Same lock credit_adjust takes (re-entrant): makes the "already applied?" check race-free.
  perform pg_advisory_xact_lock(hashtextextended('credit:' || p_workspace::text, 0));

  select exists (select 1 from public.credit_ledger l where l.idempotency_key = v_key) into v_existed;
  select b.available into v_before from public.credit_balance(p_workspace) b;

  v_id := public.credit_adjust(p_workspace, p_delta, btrim(p_reason), v_key, 'admin_adjust', p_admin::text);

  select b.available into v_after from public.credit_balance(p_workspace) b;

  if not v_existed then
    insert into public.admin_audit (admin_id, action, target_type, target_id, diff, ip)
    values (
      p_admin,
      case when p_delta > 0 then 'credit_grant' else 'credit_revoke' end,
      'workspace',
      p_workspace::text,
      jsonb_build_object(
        'delta', p_delta,
        'reason', btrim(p_reason),
        'ledger_id', v_id,
        'available_before', v_before,
        'available_after', v_after
      ),
      p_ip
    );
  end if;

  return v_id;
end;
$$;

revoke all on function public.admin_user_overview(text, integer, integer)                       from public, anon, authenticated;
revoke all on function public.admin_credit_adjust(uuid, uuid, integer, text, text, text)       from public, anon, authenticated;
grant execute on function public.admin_user_overview(text, integer, integer)                    to service_role;
grant execute on function public.admin_credit_adjust(uuid, uuid, integer, text, text, text)    to service_role;
