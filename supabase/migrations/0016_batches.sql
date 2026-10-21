-- 0016_batches.sql — Batch 11, part 2: batches (PLAN §4.2). Requires 0015.
--
-- A batch is a set of APPROVED items that will be written together. A silo can have one or more batches (the app suggests
-- them: pillar first, then by priority, 10-20 per batch by default); a manual batch may mix items of several silos
-- (silo_id is then null). Creating a batch moves its items approved -> in_batch; cancelling it (or removing items) moves
-- them back to approved. Writing the articles (and the credit hold for it) is a later phase: nothing here spends credits,
-- so `credit_estimate` stays null until article prices are decided.
--
-- Batch statuses: planned (today's only live one), running, completed (later phases), canceled.
-- Rules enforced HERE (the app calls the functions through the service role after authenticating the user):
--   * the caller must be a member of the workspace (42501); run / batch missing = PM004;
--   * creating needs a FINISHED run (PM003); every item must be of that run (PM004) and `approved` (PM003);
--   * 1-100 items per batch, at most 200 batches / 1000 items per call, no item twice (22023);
--   * only a `planned` batch can be cancelled or have items removed (PM003); replaying a cancel returns 0.

create table public.batches (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  project_id      uuid not null references public.projects (id) on delete cascade,
  map_run_id      uuid not null references public.map_runs (id) on delete cascade,
  silo_id         uuid references public.silos (id) on delete set null,
  name            text not null check (char_length(btrim(name)) between 1 and 120),
  origin          text not null check (origin in ('auto', 'manual')),
  status          text not null default 'planned' check (status in ('planned', 'running', 'completed', 'canceled')),
  position        integer not null default 0,
  credit_estimate integer check (credit_estimate is null or credit_estimate >= 0),
  scheduled_for   timestamptz,
  created_at      timestamptz not null default now()
);
create index batches_run_idx on public.batches (map_run_id, position);
create index batches_workspace_idx on public.batches (workspace_id);

-- no ON DELETE action on purpose: deleting a batch that still has items must fail; deleting a whole run/project removes both.
alter table public.plan_items add column batch_id uuid references public.batches (id);
create index plan_items_batch_idx on public.plan_items (batch_id);
alter table public.plan_items add constraint plan_items_batch_chk check (
  (status <> 'in_batch' or batch_id is not null)
  and (batch_id is null or status not in ('proposed', 'approved', 'rejected', 'already_exists')));

alter table public.batches enable row level security;
revoke all on public.batches from public, anon, authenticated;
grant select on public.batches to authenticated;
create policy batches_select on public.batches for select to authenticated using (public.is_workspace_member(workspace_id));

-- p_batches = [{"name": "...", "item_ids": ["<uuid>", ...]}, ...]; returns the new batch ids in order.
create function public.batches_create(p_user uuid, p_run uuid, p_batches jsonb, p_origin text)
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.map_runs;
  b jsonb;
  v_name text;
  v_ids uuid[];
  v_seen uuid[] := '{}';
  v_out uuid[] := '{}';
  v_silo uuid;
  v_batch uuid;
  v_pos integer;
  v_total integer := 0;
begin
  perform public.plan_edit_guard(p_user, p_run);   -- membership (42501), run exists (PM004), run finished (PM003), run locked
  select * into r from public.map_runs where id = p_run;
  if p_origin is null or p_origin not in ('auto', 'manual') then
    raise exception 'invalid_origin' using errcode = '22023';
  end if;
  if jsonb_typeof(p_batches) is distinct from 'array' or jsonb_array_length(p_batches) not between 1 and 200 then
    raise exception 'invalid_batches' using errcode = '22023';
  end if;
  select coalesce(max(position), 0) into v_pos from public.batches where map_run_id = p_run;

  for b in select value from jsonb_array_elements(p_batches) loop
    v_name := btrim(coalesce(b ->> 'name', ''));
    if char_length(v_name) not between 1 and 120 or jsonb_typeof(b -> 'item_ids') is distinct from 'array' then
      raise exception 'invalid_batch' using errcode = '22023';
    end if;
    begin
      select coalesce(array_agg(x::uuid), '{}') into v_ids from jsonb_array_elements_text(b -> 'item_ids') x;
    exception when invalid_text_representation then
      raise exception 'invalid_item_id' using errcode = '22023';
    end;
    if cardinality(v_ids) not between 1 and 100
       or (select count(distinct x) from unnest(v_ids) x) <> cardinality(v_ids)
       or v_ids && v_seen then
      raise exception 'invalid_batch_items' using errcode = '22023';
    end if;
    v_seen := v_seen || v_ids;
    v_total := v_total + cardinality(v_ids);
    if v_total > 1000 then
      raise exception 'too_many_items' using errcode = '22023';
    end if;
    if (select count(*) from public.plan_items where map_run_id = p_run and id = any (v_ids)) <> cardinality(v_ids) then
      raise exception 'item_not_found' using errcode = 'PM004';
    end if;
    if exists (select 1 from public.plan_items where id = any (v_ids) and status <> 'approved') then
      raise exception 'item_not_approved' using errcode = 'PM003';
    end if;
    -- the silo of the batch = the common silo of its items, else none (a mixed manual batch)
    select case when count(*) = count(silo_id) and count(distinct silo_id) = 1 then min(silo_id::text)::uuid end into v_silo
    from public.plan_items where id = any (v_ids);

    v_pos := v_pos + 1;
    insert into public.batches (workspace_id, project_id, map_run_id, silo_id, name, origin, position)
    values (r.workspace_id, r.project_id, p_run, v_silo, v_name, p_origin, v_pos)
    returning id into v_batch;
    update public.plan_items set status = 'in_batch', batch_id = v_batch where id = any (v_ids);
    v_out := v_out || v_batch;
  end loop;
  return v_out;
end;
$$;

-- Internal: loads + locks a batch and checks that the caller is a member of its workspace.
create function public.batch_edit_guard(p_user uuid, p_batch uuid)
returns public.batches
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.batches;
begin
  select * into v from public.batches where id = p_batch for update;
  if not found then
    raise exception 'batch_not_found' using errcode = 'PM004';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = v.workspace_id and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v;
end;
$$;

-- Cancel a planned batch: its items go back to approved. Returns the number of items released (0 on a replay).
create function public.batch_cancel(p_user uuid, p_batch uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.batches;
  v_n integer;
begin
  v := public.batch_edit_guard(p_user, p_batch);
  if v.status = 'canceled' then
    return 0;
  end if;
  if v.status <> 'planned' then
    raise exception 'batch_not_planned' using errcode = 'PM003';
  end if;
  update public.plan_items set status = 'approved', batch_id = null where batch_id = v.id and status = 'in_batch';
  get diagnostics v_n = row_count;
  update public.batches set status = 'canceled' where id = v.id;
  return v_n;
end;
$$;

-- Take some items out of a planned batch (back to approved). A batch left empty is cancelled. Returns items released.
create function public.batch_remove_items(p_user uuid, p_batch uuid, p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.batches;
  v_n integer;
begin
  v := public.batch_edit_guard(p_user, p_batch);
  if p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 1000 then
    raise exception 'invalid_items' using errcode = '22023';
  end if;
  if v.status <> 'planned' then
    raise exception 'batch_not_planned' using errcode = 'PM003';
  end if;
  update public.plan_items set status = 'approved', batch_id = null
  where batch_id = v.id and status = 'in_batch' and id = any (p_ids);
  get diagnostics v_n = row_count;
  if not exists (select 1 from public.plan_items where batch_id = v.id) then
    update public.batches set status = 'canceled' where id = v.id;
  end if;
  return v_n;
end;
$$;

revoke all on function public.batches_create(uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.batch_edit_guard(uuid, uuid) from public, anon, authenticated;
revoke all on function public.batch_cancel(uuid, uuid) from public, anon, authenticated;
revoke all on function public.batch_remove_items(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.batches_create(uuid, uuid, jsonb, text) to service_role;
grant execute on function public.batch_cancel(uuid, uuid) to service_role;
grant execute on function public.batch_remove_items(uuid, uuid, uuid[]) to service_role;
