-- rls_0014.sql — tests for migration 0014 (merge / split / move plan items by hand: gates, structure, link plans)
-- rls_0018.sql — tests for migration 0018 (articles: batch run, credit hold and settlement, cancel, watchdog, cost, RLS)
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0008-0018 are applied). Safe to re-run.
-- Creates two throw-away users (A owns the runs, B is a stranger) and removes everything at the end.
-- EXPECTED OUTPUT: every row pass = true; last row  ALL CHECKS | <N> of <N> passed | (blank) | (blank) | true

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a1810101-0000-0000-0000-000000000001','b1810101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a1810101-0000-0000-0000-000000000001','b1810101-0000-0000-0000-000000000002');

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('a1810101-0000-0000-0000-000000000001','authenticated','authenticated','a18@example.test', now()),
  ('b1810101-0000-0000-0000-000000000002','authenticated','authenticated','b18@example.test', now());
create temp table t_ws as select owner_id as uid, id as ws from public.workspaces
  where owner_id in ('a1810101-0000-0000-0000-000000000001','b1810101-0000-0000-0000-000000000002');
grant select on t_ws to anon, authenticated, service_role;
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to anon, authenticated, service_role;
create function pg_temp.wsa() returns uuid language sql as $$ select ws from t_ws where uid = 'a1810101-0000-0000-0000-000000000001' $$;
create function pg_temp.j(k text) returns uuid language sql as $$ select v from t_ids where k = $1 $$;
grant execute on function pg_temp.wsa(), pg_temp.j(text) to anon, authenticated, service_role;
create function pg_temp.ua() returns uuid language sql as $$ select 'a1810101-0000-0000-0000-000000000001'::uuid $$;
create function pg_temp.ub() returns uuid language sql as $$ select 'b1810101-0000-0000-0000-000000000002'::uuid $$;
grant execute on function pg_temp.ua(), pg_temp.ub() to anon, authenticated, service_role;

set role service_role;
select public.credit_adjust(pg_temp.wsa(), 100, 'test_grant', 'test-0018:' || pg_temp.wsa()::text, 'test', 'x');
insert into t_ids values ('ok',   public.map_run_create(pg_temp.wsa(), pg_temp.ua(), 'peinados', 'es', 'es-MX', 20, 50, 'fast', 'k-a18-ok'));
insert into t_ids values ('live', public.map_run_create(pg_temp.wsa(), pg_temp.ua(), 'tatuajes', 'es', 'es-MX', 20, 50, 'fast', 'k-a18-live'));
reset role;

-- run ok: 8 items; silo s1 = i1..i4 (pillar i1), silo s2 = i5..i8 (pillar i5); i2 has variant 'v2a', i4 has variant 'ghost'
-- (no keyword candidate behind it); candidate 'v2a' exists as a merged one. Run live: one silo, two items.
insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, seq, status)
select pg_temp.wsa(), pg_temp.j('ok'), 'kw' || g, 'kw' || g, 'es', 'test', g, 'primary' from generate_series(1, 8) g;
insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, seq, status, merged_into)
select pg_temp.wsa(), pg_temp.j('ok'), 'v2a', 'v2a', 'es', 'test', 20, 'merged', id from public.kw_candidates where map_run_id = pg_temp.j('ok') and raw = 'kw2';
insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, seq, status)
select pg_temp.wsa(), pg_temp.j('live'), 'lw' || g, 'lw' || g, 'es', 'test', g, 'primary' from generate_series(1, 2) g;

insert into public.silos (workspace_id, project_id, map_run_id, name, position)
select pg_temp.wsa(), project_id, id, 'silo ' || s, s from public.map_runs, generate_series(1, 2) s where id = pg_temp.j('ok');
insert into public.silos (workspace_id, project_id, map_run_id, name, position)
select pg_temp.wsa(), project_id, id, 'live silo', 1 from public.map_runs where id = pg_temp.j('live');
insert into t_ids select 's' || position, id from public.silos where map_run_id = pg_temp.j('ok');
insert into t_ids select 'sl', id from public.silos where map_run_id = pg_temp.j('live');

insert into public.plan_items (workspace_id, project_id, map_run_id, silo_id, primary_kw_id, keyword, article_type, position, variants)
select pg_temp.wsa(), r.project_id, r.id, case when c.seq <= 4 then pg_temp.j('s1') else pg_temp.j('s2') end, c.id, c.raw, 'A', c.seq,
       case c.raw when 'kw2' then array['v2a'] when 'kw4' then array['ghost'] else '{}'::text[] end
from public.map_runs r join public.kw_candidates c on c.map_run_id = r.id where r.id = pg_temp.j('ok') and c.status = 'primary';
insert into public.plan_items (workspace_id, project_id, map_run_id, silo_id, primary_kw_id, keyword, article_type, position)
select pg_temp.wsa(), r.project_id, r.id, pg_temp.j('sl'), c.id, c.raw, 'A', c.seq
from public.map_runs r join public.kw_candidates c on c.map_run_id = r.id where r.id = pg_temp.j('live');
insert into t_ids select 'i' || position, id from public.plan_items where map_run_id = pg_temp.j('ok');
insert into t_ids select 'l' || position, id from public.plan_items where map_run_id = pg_temp.j('live');
update public.silos set pillar_item_id = pg_temp.j('i1') where id = pg_temp.j('s1');
update public.silos set pillar_item_id = pg_temp.j('i5') where id = pg_temp.j('s2');
update public.silos set pillar_item_id = pg_temp.j('l1') where id = pg_temp.j('sl');
select public.plan_links_fix(pg_temp.j('ok'));
select public.plan_links_fix(pg_temp.j('live'));

set role service_role;
select public.map_run_set_report(pg_temp.j('ok'), '{"verdict":"pass","checks":[]}'::jsonb);
select public.map_run_finish(pg_temp.j('ok'), 'succeeded');
reset role;

create function pg_temp.siz(s text) returns text language sql as $$ select size::text from public.silos where id = pg_temp.j($1) $$;
create function pg_temp.kids(s text) returns text language sql as $$
  select jsonb_array_length(link_plan -> 'children')::text from public.plan_items where id = (select pillar_item_id from public.silos where id = pg_temp.j($1)) $$;
grant execute on function pg_temp.siz(text), pg_temp.kids(text) to anon, authenticated, service_role;


-- NOTE: Supabase runs the whole file as ONE transaction, so now() / created_at are identical for every row. Tests must never pick
-- "the newest row" by time: art() picks the article of the LATEST BATCH of the item (batches.position grows with every batch).
-- the owner's real article price (if any) is parked while the test runs and put back at the end
create temp table t_rate_snap as select * from public.credit_rates where action = 'article_write';
delete from public.credit_rates where action = 'article_write';
create temp table t_calls (k text primary key, v text);
grant all on t_calls to anon, authenticated, service_role;
create function pg_temp.b(k text) returns uuid language sql as $$ select v::uuid from t_calls where k = $1 $$;
create function pg_temp.art(k text) returns uuid language sql as $$ select a.id from public.articles a join public.batches b on b.id = a.batch_id where a.plan_item_id = pg_temp.j($1) order by b.position desc, a.id limit 1 $$;
create function pg_temp.ist(k text) returns text language sql as $$ select status || ':' || (batch_id is not null)::text from public.plan_items where id = pg_temp.j($1) $$;
create function pg_temp.bal() returns text language sql as $$ select available || '/' || held from public.credit_balance(pg_temp.wsa()) $$;
create function pg_temp.led(s text) returns text language sql as $$ select count(*)::text from public.credit_ledger where workspace_id = pg_temp.wsa() and reason = 'batch_run' and status = $1 $$;
grant execute on function pg_temp.b(text), pg_temp.art(text), pg_temp.ist(text), pg_temp.bal(), pg_temp.led(text) to anon, authenticated, service_role;

update public.plan_items set title = 'Title ' || position where map_run_id = pg_temp.j('ok');
update public.plan_items set article_type = 'B' where id = pg_temp.j('i8');
set role service_role;
select public.plan_items_set_status(pg_temp.ua(), pg_temp.j('ok'), array[pg_temp.j('i1'),pg_temp.j('i2'),pg_temp.j('i3'),pg_temp.j('i4'),pg_temp.j('i5'),pg_temp.j('i6'),pg_temp.j('i7'),pg_temp.j('i8')], 'approved');
create function pg_temp.mk(p_name text, p_ids uuid[]) returns uuid language sql as $$
  select (public.batches_create(pg_temp.ua(), pg_temp.j('ok'), jsonb_build_array(jsonb_build_object('name', $1, 'item_ids', to_jsonb($2))), 'manual'))[1] $$;
grant execute on function pg_temp.mk(text, uuid[]) to anon, authenticated, service_role;
insert into t_calls values ('X', pg_temp.mk('X', array[pg_temp.j('i1'), pg_temp.j('i2'), pg_temp.j('i3')])::text);
reset role;
create temp table t_bal0 as select pg_temp.bal() as v;

-- ===========================================================================
-- No price set: refused (PM005), nothing changes
-- ===========================================================================
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('gate', 'without credit_rates.article_write the batch cannot start (PM005); the batch stays planned, items stay in_batch, no hold',
     pg_temp.try(format($q$select public.batch_run_start(%L, %L)$q$, pg_temp.ua(), pg_temp.b('X'))) || '/' ||
     (select status from public.batches where id = pg_temp.b('X')) || '/' || pg_temp.ist('i1') || '/' || (select count(*)::text from public.articles where batch_id = pg_temp.b('X')) || '/' || pg_temp.led('held'),
     'err:PM005/planned/in_batch:true/0/0');
reset role;

-- ===========================================================================
-- Start: rate 5, 3 articles -> hold 15
-- ===========================================================================
select public.admin_credit_rate_set((select user_id from public.profiles limit 1), 'x', 0) where false;
insert into public.credit_rates (action, credits) values ('article_write', 5);
set role service_role;
insert into t_calls values ('start', public.batch_run_start(pg_temp.ua(), pg_temp.b('X'))::text);
insert into t_calls values ('again', public.batch_run_start(pg_temp.ua(), pg_temp.b('X'))::text);
reset role;
insert into t_results (who, test, actual, expected) values
  ('start', 'returns 3; a replay returns 3 and holds nothing twice (one held ledger row of 15)',
     (select v from t_calls where k = 'start') || '/' || (select v from t_calls where k = 'again') || '/' || pg_temp.led('held') || '/' ||
     (select (-delta)::text from public.credit_ledger where id = (select credit_ledger_id from public.batches where id = pg_temp.b('X'))), '3/3/1/15'),
  ('start', 'batch running with rate 5, amount 15, estimate 15, started_at set; 3 queued articles; items writing (batch kept)',
     (select status || '/' || credit_rate || '/' || credit_amount || '/' || credit_estimate || '/' || (started_at is not null)::text from public.batches where id = pg_temp.b('X')) || '/' ||
     (select count(*)::text from public.articles where batch_id = pg_temp.b('X') and status = 'queued') || '/' || pg_temp.ist('i1') || '/' || pg_temp.ist('i3'),
     'running/5/15/15/true/3/writing:true/writing:true'),
  ('start', 'one article.outline job per article, queued, with its articleId; articles carry keyword and locale',
     (select count(*)::text from public.jobs j where j.type = 'article.outline' and j.state = 'queued' and j.payload ->> 'articleId' in (select id::text from public.articles where batch_id = pg_temp.b('X'))) || '/' ||
     (select string_agg(distinct locale, ',') from public.articles where batch_id = pg_temp.b('X')), '3/es-MX'),
  ('start', 'balance: 15 held (available dropped by 15 from before)',
     (select (split_part(v, '/', 1)::integer - split_part(pg_temp.bal(), '/', 1)::integer)::text || '/' || (split_part(pg_temp.bal(), '/', 2)::integer - split_part(v, '/', 2)::integer)::text from t_bal0), '15/15');

-- a second live article for the same item is impossible (partial unique index)
insert into t_results (who, test, actual, expected) values
  ('start', 'a second live article for an item is refused (23505)',
     pg_temp.try(format($q$insert into public.articles (workspace_id, project_id, map_run_id, batch_id, plan_item_id, keyword, locale) select workspace_id, project_id, map_run_id, batch_id, plan_item_id, keyword, locale from public.articles where id = %L$q$, pg_temp.art('i1'))), 'err:23505');

-- ===========================================================================
-- Finish: i1 and i2 ready, i3 failed -> batch settles, charges 2 x 5
-- ===========================================================================
set role service_role;
insert into t_calls values ('f1', public.article_finish(pg_temp.art('i1'), 'ready', null, '{"title":"Final 1","slug":"final-1","body_html":"<h1>Final 1</h1>","word_count":1500,"qa":{"verdict":"pass"},"stats":{"steps":3}}'::jsonb));
insert into t_calls values ('f1b', public.article_finish(pg_temp.art('i1'), 'failed', 'too late'));
reset role;
insert into t_results (who, test, actual, expected) values
  ('finish', 'a ready article stores its fields; the item is draft_ready (batch kept); a later finish is ignored (already final)',
     (select v from t_calls where k = 'f1') || '/' || (select v from t_calls where k = 'f1b') || '/' ||
     (select title || '/' || slug || '/' || word_count || '/' || (qa ->> 'verdict') || '/' || (stats ->> 'steps') || '/' || coalesce(last_error, 'none') from public.articles where id = pg_temp.art('i1')) || '/' || pg_temp.ist('i1'),
     'ready/ready/Final 1/final-1/1500/pass/3/none/draft_ready:true'),
  ('finish', 'the batch keeps running while articles are open (hold untouched)',
     (select status from public.batches where id = pg_temp.b('X')) || '/' || pg_temp.led('held') || '/' || pg_temp.led('committed'), 'running/1/0');
set role service_role;
select public.article_finish(pg_temp.art('i2'), 'ready', null, '{"word_count":1400}'::jsonb);
select public.article_finish(pg_temp.art('i3'), 'failed', 'boom');
reset role;
insert into t_results (who, test, actual, expected) values
  ('settle', 'last article final -> batch completed; stats 2 ready, 1 failed, charged 10; amount 10',
     (select status || '/' || credit_amount || '/' || (stats ->> 'ready') || '/' || (stats ->> 'failed') || '/' || (stats ->> 'canceled') || '/' || (stats ->> 'charged') || '/' || (finished_at is not null)::text from public.batches where id = pg_temp.b('X')),
     'completed/10/2/1/0/10/true'),
  ('settle', 'ledger: the 15 hold is released, 10 committed, nothing held; balance dropped by exactly 10',
     pg_temp.led('held') || '/' || pg_temp.led('committed') || '/' || pg_temp.led('released') || '/' ||
     (select (split_part(v, '/', 1)::integer - split_part(pg_temp.bal(), '/', 1)::integer)::text || '/' || (split_part(pg_temp.bal(), '/', 2)::integer - split_part(v, '/', 2)::integer)::text from t_bal0), '0/1/1/10/0'),
  ('settle', 'the failed article is free again: item approved without batch; its article keeps the error',
     pg_temp.ist('i3') || '/' || (select status || ':' || last_error from public.articles where id = pg_temp.art('i3')), 'approved:false/failed:boom');

-- ===========================================================================
-- Gates of start
-- ===========================================================================
update public.plan_items set title = null where id = pg_temp.j('i6');
set role service_role;
insert into t_calls values ('Z', pg_temp.mk('Z', array[pg_temp.j('i6')])::text);
insert into t_calls values ('B', pg_temp.mk('B', array[pg_temp.j('i8')])::text);
insert into t_results (who, test, actual, expected) values
  ('gate', 'an untitled item and a Type B item are refused (PM003)',
     pg_temp.try(format($q$select public.batch_run_start(%L, %L)$q$, pg_temp.ua(), pg_temp.b('Z'))) || '/' ||
     pg_temp.try(format($q$select public.batch_run_start(%L, %L)$q$, pg_temp.ua(), pg_temp.b('B'))), 'err:PM003/err:PM003'),
  ('gate', 'a stranger (42501), an unknown batch (PM004), a completed batch (PM003)',
     pg_temp.try(format($q$select public.batch_run_start(%L, %L)$q$, pg_temp.ub(), pg_temp.b('Z'))) || '/' ||
     pg_temp.try(format($q$select public.batch_run_start(%L, gen_random_uuid())$q$, pg_temp.ua())) || '/' ||
     pg_temp.try(format($q$select public.batch_run_start(%L, %L)$q$, pg_temp.ua(), pg_temp.b('X'))), 'err:42501/err:PM004/err:PM003');
reset role;
update public.plan_items set title = 'Title 6' where id = pg_temp.j('i6');
set role service_role;
select public.batch_cancel(pg_temp.ua(), pg_temp.b('Z'));
select public.batch_cancel(pg_temp.ua(), pg_temp.b('B'));
reset role;
-- insufficient credits: price far above the balance; the whole call rolls back
update public.credit_rates set credits = 5000 where action = 'article_write';
set role service_role;
insert into t_calls values ('G', pg_temp.mk('G', array[pg_temp.j('i3')])::text);
insert into t_results (who, test, actual, expected) values
  ('gate', 'a price above the balance fails with PM001 and changes nothing (batch planned, item in_batch, no article, no hold)',
     pg_temp.try(format($q$select public.batch_run_start(%L, %L)$q$, pg_temp.ua(), pg_temp.b('G'))) || '/' ||
     (select status from public.batches where id = pg_temp.b('G')) || '/' || pg_temp.ist('i3') || '/' || (select count(*)::text from public.articles where batch_id = pg_temp.b('G')) || '/' || pg_temp.led('held'),
     'err:PM001/planned/in_batch:true/0/0');
select public.batch_cancel(pg_temp.ua(), pg_temp.b('G'));
reset role;

-- ===========================================================================
-- Rate 0: free run, no ledger row, still settles
-- ===========================================================================
update public.credit_rates set credits = 0 where action = 'article_write';
set role service_role;
insert into t_calls values ('F', pg_temp.mk('F', array[pg_temp.j('i3')])::text);
insert into t_calls values ('fstart', public.batch_run_start(pg_temp.ua(), pg_temp.b('F'))::text);
select public.article_finish(pg_temp.art('i3'), 'ready', null, '{"word_count":10}'::jsonb);
reset role;
insert into t_results (who, test, actual, expected) values
  ('free', 'rate 0: no ledger row for the batch, articles are written, batch completes with charged 0; a failed article can be written again',
     (select credit_ledger_id is null from public.batches where id = pg_temp.b('F'))::text || '/' ||
     (select status || ':' || (stats ->> 'charged') from public.batches where id = pg_temp.b('F')) || '/' || pg_temp.ist('i3') || '/' ||
     (select count(*)::text from public.articles where plan_item_id = pg_temp.j('i3')) || '/' || pg_temp.led('held'), 'true/completed:0/draft_ready:true/2/0');

-- ===========================================================================
-- All ready: the hold is committed as it is. Cancel: unfinished ones are cancelled, finished ones charged.
-- ===========================================================================
update public.credit_rates set credits = 4 where action = 'article_write';
set role service_role;
insert into t_calls values ('Y', pg_temp.mk('Y', array[pg_temp.j('i4'), pg_temp.j('i5')])::text);
select public.batch_run_start(pg_temp.ua(), pg_temp.b('Y'));
select public.article_finish(pg_temp.art('i4'), 'ready');
select public.article_finish(pg_temp.art('i5'), 'ready');
reset role;
insert into t_results (who, test, actual, expected) values
  ('settle', 'all ready: the original hold of 8 is committed (no release/re-reserve); batch completed charged 8',
     (select status || ':' || credit_amount || ':' || (stats ->> 'charged') from public.batches where id = pg_temp.b('Y')) || '/' ||
     (select status from public.credit_ledger where id = (select credit_ledger_id from public.batches where id = pg_temp.b('Y'))), 'completed:8:8/committed');
set role service_role;
insert into t_calls values ('C', pg_temp.mk('C', array[pg_temp.j('i6'), pg_temp.j('i7')])::text);
select public.batch_run_start(pg_temp.ua(), pg_temp.b('C'));
select public.article_finish(pg_temp.art('i6'), 'ready');
insert into t_calls values ('cn', public.batch_run_cancel(pg_temp.ua(), pg_temp.b('C'))::text);
reset role;
insert into t_results (who, test, actual, expected) values
  ('cancel', 'cancel: 1 unfinished article cancelled, its item approved again, queued jobs cancelled; the ready one stays and is charged 4',
     (select v from t_calls where k = 'cn') || '/' || (select status from public.articles where id = pg_temp.art('i7')) || '/' || pg_temp.ist('i7') || '/' || pg_temp.ist('i6') || '/' ||
     (select count(*)::text from public.jobs where state = 'queued' and payload ->> 'articleId' = pg_temp.art('i7')::text) || '/' ||
     (select status || ':' || (stats ->> 'charged') || ':' || (stats ->> 'canceled') from public.batches where id = pg_temp.b('C')), '1/canceled/approved:false/draft_ready:true/0/completed:4:1');
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('cancel', 'cancelling a batch that is not running is refused (PM003); a stranger 42501',
     pg_temp.try(format($q$select public.batch_run_cancel(%L, %L)$q$, pg_temp.ua(), pg_temp.b('C'))) || '/' ||
     pg_temp.try(format($q$select public.batch_run_cancel(%L, %L)$q$, pg_temp.ub(), pg_temp.b('C'))), 'err:PM003/err:42501');
reset role;

-- ===========================================================================
-- Watchdog: dead job -> failed; stalled with no live job -> failed; a healthy one is left alone
-- ===========================================================================
update public.plan_items set status = 'approved', batch_id = null where id in (pg_temp.j('i7'), pg_temp.j('i2'));
update public.plan_items set status = 'approved' where id = pg_temp.j('i2') and false;
set role service_role;
insert into t_calls values ('W', (public.batches_create(pg_temp.ua(), pg_temp.j('ok'), jsonb_build_array(jsonb_build_object('name', 'W', 'item_ids', jsonb_build_array(pg_temp.j('i7')))), 'manual'))[1]::text);
select public.batch_run_start(pg_temp.ua(), pg_temp.b('W'));
reset role;
update public.credit_rates set credits = 3 where action = 'article_write';
alter table public.articles disable trigger articles_touch_trg;
update public.articles set updated_at = now() - interval '5 minutes' where id = pg_temp.art('i7');
alter table public.articles enable trigger articles_touch_trg;
update public.jobs set state = 'dead', finished_at = now() where payload ->> 'articleId' = pg_temp.art('i7')::text;
set role service_role;
insert into t_calls values ('wd', public.article_watchdog()::text);
reset role;
insert into t_results (who, test, actual, expected) values
  ('watchdog', 'a dead job fails its article; the item is free again; the batch settles with 0 charged',
     (select v from t_calls where k = 'wd') || '/' || (select status || ':' || last_error from public.articles where id = pg_temp.art('i7')) || '/' || pg_temp.ist('i7') || '/' ||
     (select status || ':' || (stats ->> 'charged') from public.batches where id = pg_temp.b('W')), '1/failed:a writing step failed permanently/approved:false/completed:0');
-- stalled: no live job, idle 20 minutes
set role service_role;
insert into t_calls values ('S', pg_temp.mk('S', array[pg_temp.j('i7')])::text);
select public.batch_run_start(pg_temp.ua(), pg_temp.b('S'));
reset role;
alter table public.articles disable trigger articles_touch_trg;
update public.articles set updated_at = now() - interval '20 minutes' where id = pg_temp.art('i7');
alter table public.articles enable trigger articles_touch_trg;
set role service_role;
insert into t_calls values ('wd1', public.article_watchdog()::text);
insert into t_results (who, test, actual, expected) values
  ('watchdog', 'a healthy article (live job queued) is not touched even when idle',
     (select v from t_calls where k = 'wd1') || '/' || (select status from public.articles where id = pg_temp.art('i7')), '0/queued');
reset role;
update public.jobs set state = 'canceled', finished_at = now() where payload ->> 'articleId' = pg_temp.art('i7')::text;
set role service_role;
insert into t_calls values ('wd2', public.article_watchdog()::text);
insert into t_results (who, test, actual, expected) values
  ('watchdog', 'an idle article with no live job is failed as stalled',
     (select v from t_calls where k = 'wd2') || '/' || (select last_error from public.articles where id = pg_temp.art('i7')), '1/stalled: no job left to continue the article');
reset role;

-- ===========================================================================
-- Measured cost: llm_calls of an article's job are summed
-- ===========================================================================
insert into public.llm_calls (workspace_id, job_id, task, provider, model_key, model_id, attempt, status, input_tokens, output_tokens, cost_usd)
select pg_temp.wsa(), j.id, 'article_write', 'openai', 'm', 'm', 1, s, i, o, c
from (select id from public.jobs where payload ->> 'articleId' = pg_temp.art('i4')::text limit 1) j,
     (values ('ok', 1000, 500, 0.10), ('error', 0, 0, 0.05)) v(s, i, o, c);
set role service_role;
create temp table t_sum as select * from public.admin_article_cost_summary(14) where status = 'ready';
insert into t_results (who, test, actual, expected) values
  ('cost', 'article_cost_usd = all attempts of the article jobs (0.15)', public.article_cost_usd(pg_temp.art('i4'))::numeric(12, 2)::text, '0.15'),
  ('cost', 'cost summary has a ready row with at least the 4 ready articles of this test and a positive total',
     (select (articles >= 4)::text || '/' || (total_cost_usd >= 0.15)::text || '/' || (max_cost_usd >= 0.15)::text from t_sum), 'true/true/true'),
  ('cost', 'day window is clamped', pg_temp.try($q$select public.admin_article_cost_summary(0)$q$) || '/' || pg_temp.try($q$select public.admin_article_cost_summary(100000)$q$), 'ok/ok');
reset role;
delete from public.llm_calls where task = 'article_write' and model_key = 'm' and workspace_id = pg_temp.wsa();

-- ===========================================================================
-- RLS and privileges
-- ===========================================================================
insert into public.article_sections (article_id, workspace_id, kind, idx, content, words) values (pg_temp.art('i4'), pg_temp.wsa(), 'intro', 0, '{"paragraphs":["x"]}', 1);
select set_config('request.jwt.claims', '{"sub":"a1810101-0000-0000-0000-000000000001","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'a1810101-0000-0000-0000-000000000001', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('A', 'a member reads own articles and sections', (select count(*) > 0 from public.articles)::text || '/' || (select count(*) from public.article_sections)::text, 'true/1'),
  ('A', 'cannot insert, update or delete articles or sections; cannot run the functions',
     pg_temp.try(format($q$update public.articles set title = 'hack' where id = %L$q$, pg_temp.art('i4'))) || '/' ||
     pg_temp.try(format($q$delete from public.articles where id = %L$q$, pg_temp.art('i4'))) || '/' ||
     pg_temp.try(format($q$insert into public.article_sections (article_id, workspace_id, kind, idx, content) values (%L, %L, 'item', 9, '{}')$q$, pg_temp.art('i4'), pg_temp.wsa())) || '/' ||
     pg_temp.try(format($q$select public.batch_run_start(%L, %L)$q$, pg_temp.ua(), pg_temp.b('F'))) || '/' ||
     pg_temp.try(format($q$select public.article_finish(%L, 'ready')$q$, pg_temp.art('i4'))) || '/' ||
     pg_temp.try(format($q$select public.batch_run_cancel(%L, %L)$q$, pg_temp.ua(), pg_temp.b('F'))) || '/' ||
     pg_temp.try($q$select public.article_watchdog()$q$) || '/' ||
     pg_temp.try(format($q$select public.batch_settle_if_done(%L)$q$, pg_temp.b('F'))),
     'err:42501/err:42501/err:42501/err:42501/err:42501/err:42501/err:42501/err:42501');
reset role;
select set_config('request.jwt.claims', '{"sub":"b1810101-0000-0000-0000-000000000002","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'b1810101-0000-0000-0000-000000000002', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('B', 'a stranger sees no article and no section', (select count(*) from public.articles)::text || '/' || (select count(*) from public.article_sections)::text, '0/0');
reset role;
select set_config('request.jwt.claims', '{}', false);

-- put the owner's real price back (if there was one)
delete from public.credit_rates where action = 'article_write';
insert into public.credit_rates select * from t_rate_snap;

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a1810101-0000-0000-0000-000000000001','b1810101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a1810101-0000-0000-0000-000000000001','b1810101-0000-0000-0000-000000000002');

select n, who, test, actual, expected, (actual = expected) as pass from t_results
union all
select 9999, 'ALL CHECKS', (select count(*) filter (where actual = expected) from t_results)::text || ' of ' || (select count(*) from t_results)::text || ' passed', '', '',
       (select bool_and(actual = expected) from t_results)
order by 1;
