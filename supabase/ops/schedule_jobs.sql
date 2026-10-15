-- schedule_jobs.sql — turns the job queue on. Run ONCE in the Supabase SQL Editor AFTER migrations 0001-0006,
-- AFTER the app is deployed, and AFTER you have set CRON_SECRET in Vercel (Settings -> Environment Variables,
-- then Redeploy). It is not a migration: it holds your site URL and secret, so edit the two lines marked EDIT ME.
--
-- What it schedules
--   every minute  POST <site>/api/jobs/tick   (Authorization: Bearer <CRON_SECRET>)  -> runs the worker (watchdog, claim, run)
--   daily 03:10   purge_old_events(30)        raw events kept 30 days (CLAUDE.md: 14-30 days only)
--   daily 03:20   purge_old_llm_calls(90)     LLM cost log kept 90 days (free-tier disk is 500MB)
--   daily 03:30   purge_old_jobs(30)          finished/canceled jobs kept 30 days (dead-letter rows are never auto-deleted)
--
-- The secret is stored in Supabase Vault (not written into the cron job text). Re-running this file is safe: it
-- replaces the same-named schedules and updates the stored values.
--
-- To stop everything:  select cron.unschedule('pinmentor-job-tick'); (and the three purge_* names)
-- To see runs:         select * from cron.job_run_details order by start_time desc limit 20;
--                      select id, status_code, error_msg, created from net._http_response order by created desc limit 20;

create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

-- ===== EDIT ME (1/2): your production site, no trailing slash ==========================================================
-- ===== EDIT ME (2/2): the SAME value as CRON_SECRET in Vercel (16+ characters, random) =================================
do $$
declare
  v_site   constant text := 'https://YOUR-SITE.vercel.app';
  v_secret constant text := 'PASTE-THE-SAME-CRON-SECRET-HERE';
  v_id     uuid;
begin
  if v_site like '%YOUR-SITE%' or v_site !~ '^https://[^/]+$' then
    raise exception 'Edit the site URL first (https://your-domain, no trailing slash).';
  end if;
  if v_secret like 'PASTE-%' or char_length(v_secret) < 16 then
    raise exception 'Paste the real CRON_SECRET first (the same value as in Vercel, 16+ characters).';
  end if;

  select id into v_id from vault.secrets where name = 'pinmentor_site_url';
  if v_id is null then perform vault.create_secret(v_site, 'pinmentor_site_url');
  else perform vault.update_secret(v_id, v_site); end if;

  select id into v_id from vault.secrets where name = 'pinmentor_cron_secret';
  if v_id is null then perform vault.create_secret(v_secret, 'pinmentor_cron_secret');
  else perform vault.update_secret(v_id, v_secret); end if;
end $$;

-- Replace old schedules of the same name, then (re)create them.
do $$
declare n text;
begin
  foreach n in array array['pinmentor-job-tick', 'pinmentor-purge-events', 'pinmentor-purge-llm-calls', 'pinmentor-purge-jobs'] loop
    perform cron.unschedule(n) where exists (select 1 from cron.job where jobname = n);
  end loop;
end $$;

select cron.schedule(
  'pinmentor-job-tick',
  '* * * * *',
  $cron$
    select net.http_post(
      url     := (select decrypted_secret from vault.decrypted_secrets where name = 'pinmentor_site_url') || '/api/jobs/tick',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'pinmentor_cron_secret')
                 ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 59000
    );
  $cron$
);

select cron.schedule('pinmentor-purge-events',    '10 3 * * *', $cron$ select public.purge_old_events(30) $cron$);
select cron.schedule('pinmentor-purge-llm-calls', '20 3 * * *', $cron$ select public.purge_old_llm_calls(90) $cron$);
select cron.schedule('pinmentor-purge-jobs',      '30 3 * * *', $cron$ select public.purge_old_jobs(30) $cron$);

-- Check: should list 4 rows, all active.
select jobname, schedule, active from cron.job where jobname like 'pinmentor-%' order by jobname;
