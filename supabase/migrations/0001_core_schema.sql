-- 0001_core_schema.sql
-- PinMentor Batch 01B (tasks 0.2 + 0.3, DB side)
-- Tables: languages, profiles, workspaces, workspace_members, trials
-- + signup trigger (profile + workspace + owner membership, trial grant on email confirmation)
-- + RLS on every table.
--
-- Paste into Supabase SQL Editor and run once. Never edit after it is applied;
-- later changes go in 0002_*.sql and up.
--
-- Notes
--  * `profiles` is per-user and `languages` is global reference data, so neither carries
--    workspace_id (CLAUDE.md rule applies to workspace data tables). Everything else does.
--  * Clients get SELECT only (plus two narrow column-level UPDATEs). All other writes go
--    through SECURITY DEFINER functions / the service_role key on the server.
--  * The credit ledger arrives in 0002/0.4. For now the trial grant is recorded in `trials`.

-- ---------------------------------------------------------------------------
-- languages (global reference data)
-- ---------------------------------------------------------------------------
create table public.languages (
  code            text primary key check (code ~ '^[a-z]{2}$'),
  locale          text not null,
  name            text not null,
  stopwords       text[] not null default '{}',
  cta_pool        text[] not null default '{}',
  title_templates jsonb  not null default '{}'::jsonb,
  banned_phrases  text[] not null default '{}'
);

insert into public.languages (code, locale, name, stopwords) values
  ('es', 'es-MX', 'Español',
   array['a','al','con','de','del','el','la','las','los','en','y','o','un','una','unos','unas','por','que','se','su','sus','lo','e','u']),
  ('en', 'en-US', 'English',
   array['a','an','the','of','and','or','in','on','to','at','is','are','be','that','this','it','its']);

-- ---------------------------------------------------------------------------
-- profiles (one row per auth user)
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  role               text not null default 'user'
                       check (role in ('user','support','finance','analyst','superadmin')),
  suspended          boolean not null default false,
  signup_attribution jsonb not null default '{}'::jsonb,
  country            text,
  locale             text,
  last_seen_at       timestamptz,
  created_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- workspaces + members
-- ---------------------------------------------------------------------------
create table public.workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 120),
  owner_id   uuid not null references auth.users (id) on delete cascade,
  plan_id    text,  -- FK to plans arrives with billing (phase 7)
  created_at timestamptz not null default now()
);
create index workspaces_owner_id_idx on public.workspaces (owner_id);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         text not null default 'member' check (role in ('owner','admin','member')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_id_idx on public.workspace_members (user_id);

-- ---------------------------------------------------------------------------
-- trials (minimal; credit ledger comes in 0.4)
-- ---------------------------------------------------------------------------
create table public.trials (
  workspace_id          uuid primary key references public.workspaces (id) on delete cascade,
  granted_credits       integer not null check (granted_credits >= 0),
  email_hash            text not null,
  wp_domain_hash        text,
  pinterest_account_hash text,
  granted_at            timestamptz not null default now()
);
create index trials_email_hash_idx on public.trials (email_hash);

-- ---------------------------------------------------------------------------
-- Helper: membership check used by RLS policies.
-- SECURITY DEFINER so it can read workspace_members without recursing into its own policy.
-- ---------------------------------------------------------------------------
create function public.is_workspace_member(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = ws
      and m.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_workspace_member(uuid) from public, anon;
grant execute on function public.is_workspace_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Trial grant (internal). Trial size = 30 credits (owner decision, batch 01B).
-- Changing it later = new migration that redefines this function.
-- ---------------------------------------------------------------------------
create function public.grant_trial(p_workspace uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.trials (workspace_id, granted_credits, email_hash)
  values (
    p_workspace,
    30,
    encode(sha256(convert_to(lower(btrim(coalesce(p_email, ''))), 'utf8')), 'hex')
  )
  on conflict (workspace_id) do nothing;
end;
$$;

revoke all on function public.grant_trial(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Signup: profile + workspace + owner membership. Trial only once the email is confirmed
-- (magic-link click confirms it), so unverified signups never get credits.
-- ---------------------------------------------------------------------------
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws uuid;
begin
  insert into public.profiles (user_id) values (new.id) on conflict do nothing;

  insert into public.workspaces (name, owner_id)
  values ('My workspace', new.id)
  returning id into ws;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (ws, new.id, 'owner');

  if new.email_confirmed_at is not null then
    perform public.grant_trial(ws, new.email);
  end if;

  return new;
end;
$$;

create function public.handle_user_confirmed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws uuid;
begin
  select w.id into ws
  from public.workspaces w
  where w.owner_id = new.id
  order by w.created_at
  limit 1;

  if ws is not null then
    perform public.grant_trial(ws, new.email);
  end if;

  return new;
end;
$$;

revoke all on function public.handle_new_user()        from public, anon, authenticated;
revoke all on function public.handle_user_confirmed()  from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create trigger on_auth_user_confirmed
  after update of email_confirmed_at on auth.users
  for each row
  when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function public.handle_user_confirmed();

-- ---------------------------------------------------------------------------
-- Privileges: start from zero, grant the minimum.
-- ---------------------------------------------------------------------------
revoke all on public.languages, public.profiles, public.workspaces,
              public.workspace_members, public.trials
  from public, anon, authenticated;

grant select on public.languages         to anon, authenticated;
grant select on public.profiles          to authenticated;
grant update (locale) on public.profiles to authenticated;   -- role/suspended are NOT user-editable
grant select on public.workspaces        to authenticated;
grant update (name) on public.workspaces to authenticated;   -- owner_id/plan_id are NOT user-editable
grant select on public.workspace_members to authenticated;
grant select on public.trials            to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.languages         enable row level security;
alter table public.profiles          enable row level security;
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table public.trials            enable row level security;

create policy languages_read on public.languages
  for select to anon, authenticated using (true);

create policy profiles_select_own on public.profiles
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy workspaces_select_member on public.workspaces
  for select to authenticated
  using (public.is_workspace_member(id));

create policy workspaces_update_owner on public.workspaces
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy workspace_members_select on public.workspace_members
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_workspace_member(workspace_id));

create policy trials_select_member on public.trials
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- No INSERT/DELETE policies (and no INSERT/DELETE grants) on purpose:
-- rows are created by the signup trigger or by server code using service_role.
