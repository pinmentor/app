-- 0009_pgvector.sql
-- PinMentor Batch 05, part 2: pgvector for the S4 semantic dedup (PLAN §3.6 layer 1).
-- Requires 0008. Paste into Supabase SQL Editor and run ONCE, then run supabase/tests/pgvector_0009.sql.
--
-- IMPORTANT: this file could NOT be executed in the sandbox where it was written (no pgvector there). It is small
-- on purpose; if any statement errors, stop and send me the message. pgvector ships with Supabase: the extension is
-- created in the `extensions` schema, so every reference below is schema-qualified.
--
-- Free-tier disk (500 MB): a 1536-dim vector is ~6 KB. A 500-item map has ~2,000-4,000 candidates = ~12-24 MB while
-- the run is in flight; map_run_drop_embeddings() empties every non-primary after dedup (PLAN §3.11).

create extension if not exists vector with schema extensions;

alter table public.kw_candidates add column embedding extensions.vector(1536);

-- Members must not download raw vectors (6 KB each, useless to them): re-grant SELECT on every column except `embedding`.
revoke select on public.kw_candidates from authenticated;
grant select (id, workspace_id, map_run_id, raw, raw_key, norm_key, lang, source, facet_id, seq, status, merged_into, merge_reason,
              intent, funnel, demand_tier, demand_source, volume, difficulty, comp_score, priority, flags, created_at)
  on public.kw_candidates to authenticated;

-- Writes a batch of vectors: p_items = [{"id": "<uuid>", "embedding": [..1536 numbers..]}, ...]. Only rows of THIS run.
create function public.kw_set_embeddings(p_run uuid, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) > 500 then
    raise exception 'invalid_items' using errcode = '22023';
  end if;
  update public.kw_candidates c
  set embedding = (e.item ->> 'embedding')::extensions.vector(1536)
  from jsonb_array_elements(p_items) as e(item)
  where c.id = (e.item ->> 'id')::uuid and c.map_run_id = p_run;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Candidate pairs (x, y) with x.seq in [p_from, p_to), y.seq > x.seq and cosine >= p_min, among status 'raw' rows of one
-- run. The caller walks p_from/p_to in chunks (<60 s per job). Brute force on one run's rows: fine for a few thousand rows.
create function public.kw_neighbors(p_run uuid, p_from integer, p_to integer, p_min real)
returns table (a uuid, b uuid, cosine real)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select x.id, y.id, (1 - (x.embedding operator(extensions.<=>) y.embedding))::real
  from public.kw_candidates x
  join public.kw_candidates y on y.map_run_id = x.map_run_id and y.seq > x.seq
  where x.map_run_id = p_run
    and x.seq >= p_from and x.seq < p_to
    and x.status = 'raw' and y.status = 'raw'
    and x.embedding is not null and y.embedding is not null
    and (1 - (x.embedding operator(extensions.<=>) y.embedding)) >= p_min
  order by 3 desc, 1, 2;   -- stable order so the caller can page with .range() (PostgREST returns <= 1000 rows per call)
end;
$$;

-- After dedup: vectors of everything that is not a primary are dead weight.
create function public.map_run_drop_embeddings(p_run uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  update public.kw_candidates set embedding = null
  where map_run_id = p_run and status <> 'primary' and embedding is not null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.kw_set_embeddings(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.kw_neighbors(uuid, integer, integer, real) from public, anon, authenticated;
revoke all on function public.map_run_drop_embeddings(uuid) from public, anon, authenticated;
grant execute on function public.kw_set_embeddings(uuid, jsonb) to service_role;
grant execute on function public.kw_neighbors(uuid, integer, integer, real) to service_role;
grant execute on function public.map_run_drop_embeddings(uuid) to service_role;
