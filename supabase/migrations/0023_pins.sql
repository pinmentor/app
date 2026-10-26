-- 0023_pins.sql — Batch 19: Pinterest pin TEXTS for a finished article (no images, no posting to Pinterest yet). Requires 0018, 0019.
--
--   * pins : one row per pin text (angle, title, description, alt text, keywords, Bengali meaning, mechanical checks, status).
--            Members read their own; only the server writes (service_role), the owner approves/rejects through pin_set_status.
--   * pin_copy_request : member-only; article must be `ready`; creates ONE job (idempotent). Refused (PM003) while the article still
--                        has non-rejected pins: reject them first to get a fresh set.
--   * pin_set_status   : member-only; draft | approved | rejected.
-- Job payload uses `pinArticleId` (not `articleId`) so article cost reports and the article watchdog never count pin work.
-- Credits: free (no price exists); the AI cost shows under the task `pin_copy` on /admin/credits.

create table public.pins (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  article_id   uuid not null references public.articles (id) on delete cascade,
  position     integer not null check (position between 1 and 20),
  angle        text not null default '' check (char_length(angle) <= 160),
  title        text not null check (char_length(title) between 1 and 100),
  description  text not null check (char_length(description) <= 500),
  alt          text not null default '' check (char_length(alt) <= 500),
  keywords     text[] not null default '{}',
  gloss_bn     text check (gloss_bn is null or char_length(gloss_bn) <= 1500),
  checks       jsonb not null default '{}'::jsonb,
  status       text not null default 'draft' check (status in ('draft', 'approved', 'rejected')),
  created_at   timestamptz not null default now(),
  unique (article_id, position)
);
create index pins_article_idx on public.pins (article_id);
create index pins_workspace_idx on public.pins (workspace_id);

alter table public.pins enable row level security;
create policy pins_select on public.pins for select to authenticated using (public.is_workspace_member(workspace_id));
revoke all on public.pins from public, anon, authenticated;
grant select on public.pins to authenticated;
grant select, insert, update, delete on public.pins to service_role;

create function public.pin_copy_request(p_user uuid, p_article uuid, p_count integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.articles;
  v_dead integer;
  v_pre  text;
begin
  select * into a from public.articles where id = p_article;
  if not found then
    raise exception 'article_not_found' using errcode = 'PM004';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = a.workspace_id and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_count is null or p_count < 1 or p_count > 10 then
    raise exception 'invalid_count' using errcode = '22023';
  end if;
  if a.status <> 'ready' then
    raise exception 'article_not_ready' using errcode = 'PM003';
  end if;
  if exists (select 1 from public.pins p where p.article_id = a.id and p.status <> 'rejected') then
    raise exception 'pins_exist' using errcode = 'PM003';
  end if;
  -- a set the owner rejected is replaced: the old rows go, so the new job starts clean
  delete from public.pins where article_id = a.id and status = 'rejected';
  v_pre := 'pins:' || a.id::text || ':';
  select count(*) into v_dead from public.jobs where left(idempotency_key, length(v_pre)) = v_pre and state in ('dead', 'canceled', 'succeeded');
  perform public.job_enqueue(a.workspace_id, 'pin.copy',
                             jsonb_build_object('pinArticleId', a.id, 'count', p_count),
                             v_pre || v_dead::text, null, now(), 3, 0, null, null, 'pins');
end;
$$;

create function public.pin_set_status(p_user uuid, p_pin uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.pins;
begin
  if p_status is null or p_status not in ('draft', 'approved', 'rejected') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  select * into p from public.pins where id = p_pin;
  if not found then
    raise exception 'pin_not_found' using errcode = 'PM004';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = p.workspace_id and m.user_id = p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.pins set status = p_status where id = p.id;
end;
$$;

revoke all on function public.pin_copy_request(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.pin_set_status(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.pin_copy_request(uuid, uuid, integer) to service_role;
grant execute on function public.pin_set_status(uuid, uuid, text) to service_role;
