-- 0017_credit_rates_admin.sql — Batch 12, part 1: credit prices are set by the owner from the admin area.
--
-- The owner decided (2026-10-21) to price an article only after measuring what it costs in tokens, so the price is NOT in
-- code or in a migration: it is a row of credit_rates that a superadmin writes on /admin/credits. This file adds
--   * credit_rates.note + updated_by (who set it, why),
--   * admin_credit_rate_set / admin_credit_rate_delete: superadmin only (re-checked here), both write admin_audit,
--   * admin_llm_cost_by_task: the measured tokens and cost per call of each task (the basis for a price).
-- No price is inserted here. The action the article writer looks for is `article_write` (credits PER ARTICLE); until a
-- superadmin sets it, running a batch is refused (0018).

alter table public.credit_rates add column note text check (note is null or char_length(note) <= 200);
alter table public.credit_rates add column updated_by uuid references auth.users (id) on delete set null;

create function public.admin_credit_rate_set(p_admin uuid, p_action text, p_credits integer, p_note text default null, p_ip text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role   text;
  v_before integer;
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select p.role into v_role from public.profiles p where p.user_id = p_admin;
  if v_role is distinct from 'superadmin' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_action is null or p_action !~ '^[a-z][a-z0-9_.]{1,63}$' or p_credits is null or p_credits not between 0 and 100000
     or (v_note is not null and char_length(v_note) > 200) then
    raise exception 'invalid_rate' using errcode = '22023';
  end if;

  select r.credits into v_before from public.credit_rates r where r.action = p_action;
  insert into public.credit_rates (action, credits, note, updated_by, updated_at)
  values (p_action, p_credits, v_note, p_admin, now())
  on conflict (action) do update
    set credits = excluded.credits, note = excluded.note, updated_by = excluded.updated_by, updated_at = now();

  insert into public.admin_audit (admin_id, action, target_type, target_id, diff, ip)
  values (p_admin, 'credit_rate_set', 'credit_rate', p_action,
          jsonb_build_object('action', p_action, 'before', v_before, 'after', p_credits, 'note', v_note), p_ip);
end;
$$;

-- Deleting a rate makes the action "unpriced" again (the article writer then refuses to start). `test_job` is kept: the
-- admin test buttons need it.
create function public.admin_credit_rate_delete(p_admin uuid, p_action text, p_ip text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role   text;
  v_before integer;
begin
  select p.role into v_role from public.profiles p where p.user_id = p_admin;
  if v_role is distinct from 'superadmin' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_action is null or p_action = 'test_job' then
    raise exception 'invalid_rate' using errcode = '22023';
  end if;
  delete from public.credit_rates where action = p_action returning credits into v_before;
  if not found then
    return false;
  end if;
  insert into public.admin_audit (admin_id, action, target_type, target_id, diff, ip)
  values (p_admin, 'credit_rate_delete', 'credit_rate', p_action, jsonb_build_object('action', p_action, 'before', v_before), p_ip);
  return true;
end;
$$;

-- Measured cost per call of each task over the last p_days days (1-90). Failed attempts are listed separately: they are
-- real spend too (total_cost_usd counts them), but they are not part of the per-call average of a successful call.
create function public.admin_llm_cost_by_task(p_days integer default 14)
returns table (
  task           text,
  ok_calls       bigint,
  failed_calls   bigint,
  avg_input_tok  integer,
  avg_output_tok integer,
  avg_cost_usd   numeric,
  total_cost_usd numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    l.task,
    count(*) filter (where l.status = 'ok'),
    count(*) filter (where l.status <> 'ok'),
    coalesce(avg(l.input_tokens) filter (where l.status = 'ok'), 0)::integer,
    coalesce(avg(l.output_tokens) filter (where l.status = 'ok'), 0)::integer,
    coalesce(avg(l.cost_usd) filter (where l.status = 'ok'), 0)::numeric(12, 6),
    coalesce(sum(l.cost_usd), 0)::numeric(12, 6)
  from public.llm_calls l
  where l.created_at >= now() - make_interval(days => least(greatest(coalesce(p_days, 14), 1), 90))
  group by l.task
  order by sum(l.cost_usd) desc, l.task;
$$;

revoke all on function public.admin_credit_rate_set(uuid, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.admin_credit_rate_delete(uuid, text, text) from public, anon, authenticated;
revoke all on function public.admin_llm_cost_by_task(integer) from public, anon, authenticated;
grant execute on function public.admin_credit_rate_set(uuid, text, integer, text, text) to service_role;
grant execute on function public.admin_credit_rate_delete(uuid, text, text) to service_role;
grant execute on function public.admin_llm_cost_by_task(integer) to service_role;
