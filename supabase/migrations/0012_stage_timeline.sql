-- 0012_stage_timeline.sql — Batch 08: when did each stage of a map run start?
--
-- map_run_set_stage keeps its signature and behaviour; when the stage CHANGES it also appends
-- {"stage": "...", "at": "<utc timestamp>"} to map_runs.stats -> 'timeline'. /admin/maps/[id] shows the durations,
-- so slow stages are measured instead of guessed. Setting the same stage again (retries) adds nothing.
create or replace function public.map_run_set_stage(p_run uuid, p_stage text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.map_runs
  set stats = case
        when stage is distinct from p_stage then
          jsonb_set(stats, '{timeline}',
                    coalesce(stats -> 'timeline', '[]'::jsonb)
                    || jsonb_build_array(jsonb_build_object('stage', p_stage, 'at', to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
                    true)
        else stats
      end,
      stage = p_stage,
      status = 'running'
  where id = p_run and status in ('queued', 'running');
$$;
