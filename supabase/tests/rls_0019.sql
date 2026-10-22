-- rls_0019.sql — tests for migration 0019 (article review column, translation gloss, gloss request, route, cost separation)
-- How to run: Supabase SQL Editor -> paste whole file -> Run (after 0008-0019 are applied). Safe to re-run.
-- Creates two throw-away users (A owns the data, B is a stranger) and removes everything at the end.
-- Supabase runs the whole file as ONE transaction: now() is identical everywhere, so no test picks "the newest row" by time.
-- EXPECTED OUTPUT: every row pass = true; last row  ALL CHECKS | <N> of <N> passed | (blank) | (blank) | true

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a1910101-0000-0000-0000-000000000001','b1910101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a1910101-0000-0000-0000-000000000001','b1910101-0000-0000-0000-000000000002');

drop table if exists pg_temp.t_results;
create temp table t_results (n serial, who text, test text, actual text, expected text);
grant all on t_results to anon, authenticated, service_role;
grant usage on sequence t_results_n_seq to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return 'err:' || sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('a1910101-0000-0000-0000-000000000001','authenticated','authenticated','a19@example.test', now()),
  ('b1910101-0000-0000-0000-000000000002','authenticated','authenticated','b19@example.test', now());
create temp table t_ws as select owner_id as uid, id as ws from public.workspaces
  where owner_id in ('a1910101-0000-0000-0000-000000000001','b1910101-0000-0000-0000-000000000002');
grant select on t_ws to anon, authenticated, service_role;
create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to anon, authenticated, service_role;
create function pg_temp.wsa() returns uuid language sql as $$ select ws from t_ws where uid = 'a1910101-0000-0000-0000-000000000001' $$;
create function pg_temp.j(k text) returns uuid language sql as $$ select v from t_ids where k = $1 $$;
create function pg_temp.ua() returns uuid language sql as $$ select 'a1910101-0000-0000-0000-000000000001'::uuid $$;
create function pg_temp.ub() returns uuid language sql as $$ select 'b1910101-0000-0000-0000-000000000002'::uuid $$;
grant execute on function pg_temp.wsa(), pg_temp.j(text), pg_temp.ua(), pg_temp.ub() to anon, authenticated, service_role;

set role service_role;
insert into t_ids values ('run', public.map_run_create(pg_temp.wsa(), pg_temp.ua(), 'peinados', 'es', 'es-MX', 20, 50, 'fast', 'k-a19-run'));
reset role;

-- fixture by direct insert: one completed batch, three items, articles: 'rd' ready (n = 7), 'wr' writing, 'rd2' ready (n = 6, one part fewer)
insert into public.kw_candidates (workspace_id, map_run_id, raw, raw_key, lang, source, seq, status)
select pg_temp.wsa(), pg_temp.j('run'), 'kw' || g, 'kw' || g, 'es', 'test', g, 'primary' from generate_series(1, 3) g;
insert into public.plan_items (workspace_id, project_id, map_run_id, primary_kw_id, keyword, article_type, position, title, list_count)
select pg_temp.wsa(), r.project_id, r.id, c.id, c.raw, 'A', c.seq, 'Title ' || c.seq, 7
from public.map_runs r join public.kw_candidates c on c.map_run_id = r.id where r.id = pg_temp.j('run');
insert into t_ids select 'i' || position, id from public.plan_items where map_run_id = pg_temp.j('run');
insert into public.batches (workspace_id, project_id, map_run_id, name, origin, status)
select pg_temp.wsa(), project_id, id, 'B19', 'manual', 'completed' from public.map_runs where id = pg_temp.j('run');
insert into t_ids select 'b', id from public.batches where map_run_id = pg_temp.j('run');
update public.plan_items set status = 'in_batch', batch_id = pg_temp.j('b') where map_run_id = pg_temp.j('run') and id in (pg_temp.j('i1'), pg_temp.j('i2'), pg_temp.j('i3'));
update public.plan_items set status = 'writing' where id = pg_temp.j('i2');
update public.plan_items set status = 'draft_ready' where id in (pg_temp.j('i1'), pg_temp.j('i3'));
insert into public.articles (workspace_id, project_id, map_run_id, batch_id, plan_item_id, keyword, locale, status, outline)
select pg_temp.wsa(), project_id, map_run_id, batch_id, id, keyword, 'es-MX',
       case id when pg_temp.j('i1') then 'ready' when pg_temp.j('i2') then 'writing' else 'ready' end,
       case id when pg_temp.j('i3') then '{"n":6}'::jsonb else '{"n":7}'::jsonb end
from public.plan_items where map_run_id = pg_temp.j('run');
create function pg_temp.art(k text) returns uuid language sql as $$ select id from public.articles where plan_item_id = pg_temp.j($1) $$;
grant execute on function pg_temp.art(text) to anon, authenticated, service_role;

-- ===========================================================================
-- article_finish carries the review; everything else of it is unchanged
-- ===========================================================================
create temp table t_calls (k text primary key, v text);
grant all on t_calls to anon, authenticated, service_role;
create temp table t_before as select review::text as v from public.articles where id = pg_temp.art('i1');
set role service_role;
insert into t_calls values ('fin', public.article_finish(pg_temp.art('i2'), 'ready', null, '{"qa":{"verdict":"flag"},"review":{"status":"done","issues":[{"type":"grammar"}]}}'::jsonb));
reset role;
insert into t_results (who, test, actual, expected)
select 'finish', 'a finish patch with review stores it next to qa; the default review is an empty object',
       (select v from t_before) || '/' || (select v from t_calls where k = 'fin') || '/' ||
       (select (review -> 'issues' -> 0 ->> 'type') || ':' || (qa ->> 'verdict') from public.articles where id = pg_temp.art('i2')) || '/' ||
       (select status from public.plan_items where id = pg_temp.j('i2')),
       '{}/ready/grammar:flag/draft_ready';

-- ===========================================================================
-- article_gloss_request
-- ===========================================================================
create function pg_temp.gj(lang text) returns text language sql as $$
  select count(*)::text || '/' || count(*) filter (where state = 'queued')::text from public.jobs
  where type = 'article.gloss' and payload ->> 'glossArticleId' = pg_temp.art('i1')::text and payload ->> 'lang' = $1 $$;
grant execute on function pg_temp.gj(text) to anon, authenticated, service_role;

set role service_role;
insert into t_calls values ('r1', public.article_gloss_request(pg_temp.ua(), pg_temp.art('i1'), 'bn')::text);
insert into t_calls values ('r2', public.article_gloss_request(pg_temp.ua(), pg_temp.art('i1'), 'bn')::text);
insert into t_calls values ('r3', public.article_gloss_request(pg_temp.ua(), pg_temp.art('i3'), 'en')::text);
reset role;
insert into t_results (who, test, actual, expected) values
  ('gloss', 'n = 7: five parts (head, intro, items:0, items:6, faq); a replay returns 5 and queues nothing new (5 jobs, all queued)',
     (select v from t_calls where k = 'r1') || '/' || (select v from t_calls where k = 'r2') || '/' || pg_temp.gj('bn'), '5/5/5/5'),
  ('gloss', 'n = 6: four parts (one items chunk); jobs carry glossArticleId, lang, part and NOT articleId',
     (select v from t_calls where k = 'r3') || '/' ||
     (select string_agg(payload ->> 'part', ',' order by payload ->> 'part') from public.jobs where type = 'article.gloss' and payload ->> 'glossArticleId' = pg_temp.art('i3')::text) || '/' ||
     (select count(*)::text from public.jobs where type = 'article.gloss' and payload ? 'articleId'),
     '4/faq,head,intro,items:0/0'),
  ('gloss', 'the other language is separate: asking for en after bn queues 5 more jobs for en',
     (select public.article_gloss_request(pg_temp.ua(), pg_temp.art('i1'), 'en')::text) || '/' || pg_temp.gj('en') || '/' || pg_temp.gj('bn'), '5/5/5/5/5');

-- a dead job is queued again on the next request; the other parts are untouched
update public.jobs set state = 'dead', finished_at = now()
where type = 'article.gloss' and payload ->> 'glossArticleId' = pg_temp.art('i1')::text and payload ->> 'lang' = 'bn' and payload ->> 'part' = 'intro';
set role service_role;
insert into t_calls values ('r4', public.article_gloss_request(pg_temp.ua(), pg_temp.art('i1'), 'bn')::text);
reset role;
insert into t_results (who, test, actual, expected) values
  ('gloss', 'after a dead part: the request queues exactly one new job for it (6 jobs: 1 dead + 5 queued)',
     (select v from t_calls where k = 'r4') || '/' || pg_temp.gj('bn'), '5/6/5');

set role service_role;
insert into t_results (who, test, actual, expected) values
  ('gate', 'invalid language 22023, an article still being written PM003, unknown article PM004, a stranger 42501',
     pg_temp.try(format($q$select public.article_gloss_request(%L, %L, 'fr')$q$, pg_temp.ua(), pg_temp.art('i1'))) || '/' ||
     pg_temp.try(format($q$select public.article_gloss_request(%L, %L, 'en')$q$, pg_temp.ua(), pg_temp.art('i2'))) || '/' ||
     pg_temp.try(format($q$select public.article_gloss_request(%L, gen_random_uuid(), 'en')$q$, pg_temp.ua())) || '/' ||
     pg_temp.try(format($q$select public.article_gloss_request(%L, %L, 'en')$q$, pg_temp.ub(), pg_temp.art('i1'))),
     'err:22023/ok/err:PM004/err:42501');
reset role;
-- i2 was finished as ready above, so make a genuinely unfinished one to test PM003
update public.articles set status = 'writing' where id = pg_temp.art('i2');
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('gate', 'an article that is not ready is refused with PM003 and queues nothing new (the 5 jobs seen are from when it was ready, in the gate test above)',
     pg_temp.try(format($q$select public.article_gloss_request(%L, %L, 'en')$q$, pg_temp.ua(), pg_temp.art('i2'))) || '/' ||
     (select count(*)::text from public.jobs where type = 'article.gloss' and payload ->> 'glossArticleId' = pg_temp.art('i2')::text), 'err:PM003/5');
reset role;

-- ===========================================================================
-- cost separation, route, privileges, RLS
-- ===========================================================================
insert into public.llm_calls (workspace_id, job_id, task, provider, model_key, model_id, attempt, status, input_tokens, output_tokens, cost_usd)
select pg_temp.wsa(), j.id, 'article_gloss', 'openai', 'm', 'm', 1, 'ok', 100, 100, 0.50
from (select id from public.jobs where type = 'article.gloss' and payload ->> 'glossArticleId' = pg_temp.art('i1')::text limit 1) j;
insert into public.jobs (workspace_id, type, payload, idempotency_key, state)
values (pg_temp.wsa(), 'article.sections', jsonb_build_object('articleId', pg_temp.art('i1')), 'k19-sec-' || pg_temp.art('i1')::text, 'succeeded');
insert into public.llm_calls (workspace_id, job_id, task, provider, model_key, model_id, attempt, status, input_tokens, output_tokens, cost_usd)
select pg_temp.wsa(), id, 'article_write', 'openai', 'm', 'm', 1, 'ok', 100, 100, 0.10 from public.jobs where idempotency_key = 'k19-sec-' || pg_temp.art('i1')::text;
set role service_role;
insert into t_results (who, test, actual, expected) values
  ('cost', 'article_cost_usd counts the writing jobs (0.10) and ignores the later gloss jobs (0.50)',
     public.article_cost_usd(pg_temp.art('i1'))::numeric(12, 2)::text, '0.10'),
  ('route', 'the task article_gloss has a route with at least one model',
     (select (count(*) >= 1)::text from public.llm_route_models('article_gloss')), 'true');
reset role;
delete from public.llm_calls where model_key = 'm' and workspace_id = pg_temp.wsa();

set role service_role;
insert into public.article_gloss (article_id, workspace_id, lang, kind, idx, content)
values (pg_temp.art('i1'), pg_temp.wsa(), 'bn', 'head', 0, '{"title":"x","highlights":[]}'::jsonb);
insert into t_calls values ('svc', pg_temp.try(format($q$insert into public.article_gloss (article_id, workspace_id, lang, kind, idx, content) values (%L, %L, 'bn', 'intro', 0, '{"paragraphs":[]}')$q$, pg_temp.art('i1'), pg_temp.wsa())) || '/' ||
     pg_temp.try(format($q$insert into public.article_sections (article_id, workspace_id, kind, idx, content) values (%L, %L, 'intro', 0, '{"paragraphs":[]}')$q$, pg_temp.art('i1'), pg_temp.wsa())) || '/' ||
     pg_temp.try(format($q$update public.articles set last_error = null where id = %L$q$, pg_temp.art('i1'))));
reset role;
insert into t_results (who, test, actual, expected) values
  ('service', 'the service role can write and read the gloss, articles and sections tables',
     (select v from t_calls where k = 'svc') || '/' || (select count(*)::text from public.article_gloss where article_id = pg_temp.art('i1')), 'ok/ok/ok/2');

select set_config('request.jwt.claims', '{"sub":"a1910101-0000-0000-0000-000000000001","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'a1910101-0000-0000-0000-000000000001', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('A', 'a member reads own gloss rows', (select count(*)::text from public.article_gloss), '2'),
  ('A', 'cannot insert, update or delete gloss rows, and cannot request one directly',
     pg_temp.try(format($q$insert into public.article_gloss (article_id, workspace_id, lang, kind, idx, content) values (%L, %L, 'en', 'head', 0, '{}')$q$, pg_temp.art('i1'), pg_temp.wsa())) || '/' ||
     pg_temp.try($q$update public.article_gloss set lang = 'en'$q$) || '/' ||
     pg_temp.try($q$delete from public.article_gloss$q$) || '/' ||
     pg_temp.try(format($q$select public.article_gloss_request(%L, %L, 'en')$q$, pg_temp.ua(), pg_temp.art('i1'))),
     'err:42501/err:42501/err:42501/err:42501');
reset role;
select set_config('request.jwt.claims', '{"sub":"b1910101-0000-0000-0000-000000000002","role":"authenticated"}', false);
select set_config('request.jwt.claim.sub', 'b1910101-0000-0000-0000-000000000002', false);
set role authenticated;
insert into t_results (who, test, actual, expected) values
  ('B', 'a stranger sees no gloss row', (select count(*)::text from public.article_gloss), '0');
reset role;
select set_config('request.jwt.claims', '{}', false);

reset role;
alter table public.admin_audit disable trigger admin_audit_guard_del;
delete from public.admin_audit where admin_id in ('a1910101-0000-0000-0000-000000000001','b1910101-0000-0000-0000-000000000002');
alter table public.admin_audit enable trigger admin_audit_guard_del;
delete from auth.users where id in ('a1910101-0000-0000-0000-000000000001','b1910101-0000-0000-0000-000000000002');

select n, who, test, actual, expected, (actual = expected) as pass from t_results
union all
select 9999, 'ALL CHECKS', (select count(*) filter (where actual = expected) from t_results)::text || ' of ' || (select count(*) from t_results)::text || ' passed', '', '',
       (select bool_and(actual = expected) from t_results)
order by 1;
