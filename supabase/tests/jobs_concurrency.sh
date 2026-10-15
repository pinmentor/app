#!/usr/bin/env bash
# jobs_concurrency.sh — proves the job queue is race-free under parallel load (Phase 1 acceptance).
#
# NOT for the Supabase SQL Editor (needs many parallel connections). Run it from any machine with psql and a
# direct database connection string (Supabase -> Project Settings -> Database -> Connection string, URI):
#   DATABASE_URL='postgresql://postgres:<password>@<host>:5432/postgres' bash supabase/tests/jobs_concurrency.sh
# Locally (plain Postgres): PGDATABASE=pm_test bash supabase/tests/jobs_concurrency.sh
#
# Creates one throw-away user (+ workspace + 30 trial credits via the signup trigger), runs 4 parallel scenarios,
# prints PASS/FAIL per check, and removes the user (and everything it created) again. Needs migrations 0001-0006.
# Do not run against a database with live job traffic.
#
# EXPECTED OUTPUT (last line): RESULT: ALL SCENARIOS PASSED
set -u

PSQL=(psql -X -q -tA)
[ -n "${DATABASE_URL:-}" ] && PSQL=(psql "$DATABASE_URL" -X -q -tA)

USER_ID="eeeeeeee-0000-0000-0000-00000000000e"
OUT="$(mktemp -d)"
fail=0
check() { # name actual expected
  if [ "$2" = "$3" ]; then echo "PASS  $1 (got $2)"; else echo "FAIL  $1 (got $2, expected $3)"; fail=1; fi
}
q() { "${PSQL[@]}" -c "$1" 2>&1; }

cleanup() { q "delete from auth.users where id = '$USER_ID'" >/dev/null; rm -rf "$OUT"; }
trap cleanup EXIT
cleanup
OUT="$(mktemp -d)"

q "insert into auth.users (id, aud, role, email, email_confirmed_at)
   values ('$USER_ID','authenticated','authenticated','jobs-concurrency@example.test', now())" >/dev/null
WS=$(q "select id from public.workspaces where owner_id = '$USER_ID'")
[ -z "$WS" ] && { echo "FAIL  setup: no workspace created"; exit 1; }
check "start balance (trial)" "$(q "select available || '/' || held from public.credit_balance('$WS')")" "30/0"

# ---- S1: 40 queued jobs, 20 parallel claimers (up to 5 each) -> every job claimed exactly once
q "insert into public.jobs (workspace_id, type, idempotency_key) select '$WS', 'test.noop', 'cj-s1:$WS:' || g from generate_series(1, 40) g" >/dev/null
seq 1 20 | xargs -P 20 -I{} "${PSQL[@]}" -c "select count(*) from public.job_claim('w-s1-{}', 5, 120)" > "$OUT/s1.out" 2>&1
check "S1 total rows handed out" "$(awk '{s+=$1} END {print s+0}' "$OUT/s1.out")" "40"
check "S1 jobs running" "$(q "select count(*) from public.jobs where workspace_id='$WS' and idempotency_key like 'cj-s1:%' and state='running'")" "40"
check "S1 no job claimed twice (attempts = 1 for all)" "$(q "select count(*) from public.jobs where workspace_id='$WS' and idempotency_key like 'cj-s1:%' and attempts <> 1")" "0"
q "delete from public.jobs where workspace_id='$WS'" >/dev/null

# ---- S2: provider limit 4 with 30 anthropic jobs and 20 parallel claimers -> exactly 4 running, never more
q "insert into public.jobs (workspace_id, type, provider, idempotency_key) select '$WS', 'test.noop', 'anthropic', 'cj-s2:$WS:' || g from generate_series(1, 30) g" >/dev/null
seq 1 20 | xargs -P 20 -I{} "${PSQL[@]}" -c "select count(*) from public.job_claim('w-s2-{}', 5, 120, '{\"anthropic\": 4}')" > "$OUT/s2.out" 2>&1
check "S2 total rows handed out (limit 4)" "$(awk '{s+=$1} END {print s+0}' "$OUT/s2.out")" "4"
check "S2 anthropic running" "$(q "select count(*) from public.jobs where workspace_id='$WS' and state='running'")" "4"
check "S2 rest still queued" "$(q "select count(*) from public.jobs where workspace_id='$WS' and state='queued'")" "26"
q "delete from public.jobs where workspace_id='$WS'" >/dev/null

# ---- S3: 30 parallel enqueues with the SAME key + a credit action -> one job, one hold
seq 1 30 | xargs -P 30 -I{} "${PSQL[@]}" -c "select public.job_enqueue('$WS', 'test.llm_echo', '{}', 'cj-s3:$WS', 'test_job')" > "$OUT/s3.out" 2>&1
check "S3 jobs for the shared key" "$(q "select count(*) from public.jobs where idempotency_key='cj-s3:$WS'")" "1"
check "S3 holds for the shared key" "$(q "select count(*) from public.credit_ledger where workspace_id='$WS' and ref_type='job' and status='held'")" "1"
check "S3 balance (available/held)" "$(q "select available || '/' || held from public.credit_balance('$WS')")" "29/1"
check "S3 every call returned the same job id" "$(sort -u "$OUT/s3.out" | grep -cE '^[0-9a-f]{8}-')" "1"

# ---- S4: 40 parallel enqueues, DISTINCT keys, 1 credit each, balance 29 available -> exactly 29 succeed, never overdrawn
seq 1 40 | xargs -P 40 -I{} "${PSQL[@]}" -c "select public.job_enqueue('$WS', 'test.llm_echo', '{}', 'cj-s4:$WS:{}', 'test_job')" > "$OUT/s4.out" 2>&1
check "S4 enqueues succeeded" "$(grep -cE '^[0-9a-f]{8}-' "$OUT/s4.out")" "29"
check "S4 rejected (insufficient_credits)" "$(grep -c 'insufficient_credits' "$OUT/s4.out")" "11"
check "S4 balance (available/held)" "$(q "select available || '/' || held from public.credit_balance('$WS')")" "0/30"
check "S4 jobs with a hold = holds" "$(q "select (select count(*) from public.jobs where workspace_id='$WS' and credit_ledger_id is not null) || '/' || (select count(*) from public.credit_ledger where workspace_id='$WS' and status='held')")" "30/30"

if [ "$fail" = 0 ]; then echo "RESULT: ALL SCENARIOS PASSED"; else echo "RESULT: FAILURES"; exit 1; fi
