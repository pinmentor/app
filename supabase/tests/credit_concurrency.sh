#!/usr/bin/env bash
# credit_concurrency.sh — proves the ledger cannot be overdrawn under parallel load (task 0.4 acceptance).
#
# NOT for the Supabase SQL Editor (it is a single session). Run it from any machine with psql and a
# direct database connection string (Supabase → Project Settings → Database → Connection string, URI):
#   DATABASE_URL='postgresql://postgres:<password>@<host>:5432/postgres' bash supabase/tests/credit_concurrency.sh
# Locally (plain Postgres): PGDATABASE=pm_test bash supabase/tests/credit_concurrency.sh
#
# It creates one throw-away user (+ workspace via the signup trigger), runs three parallel scenarios,
# prints PASS/FAIL per scenario, and removes the user again. Needs migrations 0001 + 0002 applied.
#
# EXPECTED OUTPUT (last line): RESULT: ALL SCENARIOS PASSED
set -u

PSQL=(psql -X -q -tA)
[ -n "${DATABASE_URL:-}" ] && PSQL=(psql "$DATABASE_URL" -X -q -tA)

USER_ID="dddddddd-0000-0000-0000-00000000000d"
fail=0
check() { # name actual expected
  if [ "$2" = "$3" ]; then echo "PASS  $1 (got $2)"; else echo "FAIL  $1 (got $2, expected $3)"; fail=1; fi
}
q() { "${PSQL[@]}" -c "$1" 2>&1; }

cleanup() { q "delete from auth.users where id = '$USER_ID'" >/dev/null; }
trap cleanup EXIT
cleanup

q "insert into auth.users (id, aud, role, email, email_confirmed_at)
   values ('$USER_ID','authenticated','authenticated','concurrency@example.test', now())" >/dev/null
WS=$(q "select id from public.workspaces where owner_id = '$USER_ID'")
[ -z "$WS" ] && { echo "FAIL  setup: no workspace created"; exit 1; }

# Start from exactly 100 credits (the trial grant is 30; top up by 70).
q "select public.credit_adjust('$WS', 70, 'concurrency top-up', 'conc-topup:$WS')" >/dev/null
check "start balance" "$(q "select available || '/' || held from public.credit_balance('$WS')")" "100/0"

# Scenario 1: 50 parallel reserves of 10 against 100 credits -> exactly 10 succeed, 40 rejected, balance 0.
seq 1 50 | xargs -P 50 -I{} "${PSQL[@]}" -c "select public.credit_reserve('$WS', 10, 'parallel', 'conc-r:$WS:{}')" > /tmp/conc_s1.out 2>&1
ok=$(grep -cE '^[0-9a-f]{8}-' /tmp/conc_s1.out); rejected=$(grep -c 'insufficient_credits' /tmp/conc_s1.out)
check "S1 reserves succeeded" "$ok" "10"
check "S1 reserves rejected (insufficient_credits)" "$rejected" "40"
check "S1 balance after (available/held)" "$(q "select available || '/' || held from public.credit_balance('$WS')")" "0/100"
check "S1 never negative" "$(q "select (coalesce(sum(delta),0) >= 0)::text from public.credit_ledger where workspace_id='$WS' and status in ('held','committed')")" "true"

# Scenario 2: 50 parallel reserves with the SAME key -> exactly one ledger row. Free credits first.
q "select public.credit_release(id) from public.credit_ledger where workspace_id='$WS' and status='held'" >/dev/null
seq 1 50 | xargs -P 50 -I{} "${PSQL[@]}" -c "select public.credit_reserve('$WS', 10, 'same key', 'conc-same:$WS')" > /tmp/conc_s2.out 2>&1
check "S2 rows for the shared key" "$(q "select count(*) from public.credit_ledger where idempotency_key='conc-same:$WS'")" "1"
check "S2 balance (available/held)" "$(q "select available || '/' || held from public.credit_balance('$WS')")" "90/10"

# Scenario 3: 50 parallel commits of that one reservation -> committed once, no double charge.
RID=$(q "select id from public.credit_ledger where idempotency_key='conc-same:$WS'")
seq 1 50 | xargs -P 50 -I{} "${PSQL[@]}" -c "select public.credit_commit('$RID')" > /tmp/conc_s3.out 2>&1
check "S3 commit results (all 'committed')" "$(grep -c '^committed$' /tmp/conc_s3.out)" "50"
check "S3 balance (available/held)" "$(q "select available || '/' || held from public.credit_balance('$WS')")" "90/0"
check "S3 committed rows for key" "$(q "select count(*) from public.credit_ledger where idempotency_key='conc-same:$WS' and status='committed'")" "1"

rm -f /tmp/conc_s1.out /tmp/conc_s2.out /tmp/conc_s3.out
if [ "$fail" = 0 ]; then echo "RESULT: ALL SCENARIOS PASSED"; else echo "RESULT: FAILURES"; exit 1; fi
