import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { describeFailure, handlers, JobError } from "./handlers";
import { handlerTimeoutMs, nextRound } from "./tick-plan";

/**
 * One tick of the worker: watchdog, then rounds of claim -> run -> complete/fail until the call runs low on time (tick-plan.ts). Called every minute by /api/jobs/tick
 * (pg_cron -> pg_net). All state lives in Postgres (job_* functions), so a tick can die anywhere safely:
 * the lease expires and the watchdog re-queues the job.
 */

const MAX_JOBS_PER_TICK = 8;
const LEASE_SECONDS = 90;
// Per-provider running-job caps (job_claim). Tune here or move to feature_flags later.
const PROVIDER_LIMITS = { anthropic: 8, openai: 8, gemini: 8 };

const claimedSchema = z.array(
  z.object({
    id: z.uuid(),
    workspace_id: z.uuid(),
    type: z.string(),
    payload: z.unknown(),
    attempts: z.number().int(),
  }),
);

const watchdogSchema = z.array(
  z.object({ requeued: z.number().int(), dead: z.number().int(), released_holds: z.number().int() }),
);

export type TickSummary = {
  watchdog: { requeued: number; dead: number; released_holds: number };
  claimed: number;
  rounds: number;
  succeeded: number;
  retried: number;
  dead: number;
  lost_lease: number;
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new JobError("handler timed out", "handler_timeout", { retryable: true })), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

type Outcome = "succeeded" | "retried" | "dead" | "lost_lease";

type RoundResult = { claimed: number; outcomes: Outcome[] };

async function runRound(sb: ReturnType<typeof createAdminClient>, worker: string, timeoutMs: number): Promise<RoundResult> {
  const claimRes = await sb.rpc("job_claim", {
    p_worker: worker,
    p_limit: MAX_JOBS_PER_TICK,
    p_lease_seconds: LEASE_SECONDS,
    p_provider_limits: PROVIDER_LIMITS,
  });
  const claimed = claimedSchema.safeParse(claimRes.data ?? []);
  if (claimRes.error || !claimed.success) {
    console.error("job_claim failed:", claimRes.error?.code ?? "invalid_rows");
    throw new Error("job_claim_failed");
  }

  const outcomes: Outcome[] = await Promise.all(
    claimed.data.map(async (job): Promise<Outcome> => {
      const handler = handlers[job.type];
      try {
        if (!handler) throw new JobError("no handler for this job type", "unknown_job_type", { retryable: false });

        const result = await withTimeout(
          handler({ jobId: job.id, workspaceId: job.workspace_id, type: job.type, payload: job.payload, attempt: job.attempts }),
          timeoutMs,
        );

        const done = await sb.rpc("job_complete", { p_job: job.id, p_worker: worker, p_result: result });
        if (done.error) {
          // PM003 = the lease was lost (watchdog re-queued it): someone else owns the job now. Not our write to make.
          console.error("job_complete failed:", done.error.code ?? "no_code");
          return "lost_lease";
        }
        return "succeeded";
      } catch (e) {
        const f = describeFailure(e);
        const failed = await sb.rpc("job_fail", {
          p_job: job.id,
          p_worker: worker,
          p_error: f.message,
          p_error_code: f.code,
          p_retryable: f.retryable,
          p_retry_after_seconds: f.retryAfterSeconds,
        });
        if (failed.error) {
          console.error("job_fail failed:", failed.error.code ?? "no_code");
          return "lost_lease";
        }
        return failed.data === "dead" ? "dead" : "retried";
      }
    }),
  );
  return { claimed: claimed.data.length, outcomes };
}

/** A queued job that becomes due before the round cutoff: worth waiting a few seconds for instead of ending the call. */
async function jobDueSoon(sb: ReturnType<typeof createAdminClient>): Promise<boolean> {
  const until = new Date(Date.now() + 25_000).toISOString();
  const { count, error } = await sb.from("jobs").select("id", { count: "exact", head: true }).eq("state", "queued").lte("run_at", until);
  return !error && (count ?? 0) > 0;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runTick(): Promise<TickSummary> {
  const sb = createAdminClient();
  const worker = `tick-${randomUUID().slice(0, 8)}`;
  const started = Date.now();

  const wdRes = await sb.rpc("job_watchdog");
  const wd = watchdogSchema.safeParse(wdRes.data);
  if (wdRes.error) console.error("job_watchdog failed:", wdRes.error.code ?? "no_code");

  // fails map runs whose stage job died or that stalled, and releases their credit hold
  const mapWd = await sb.rpc("map_run_watchdog");
  if (mapWd.error) console.error("map_run_watchdog failed:", mapWd.error.code ?? "no_code");

  const outcomes: Outcome[] = [];
  let claimed = 0;
  let rounds = 0;
  for (;;) {
    const elapsed = Date.now() - started;
    const r = await runRound(sb, worker, handlerTimeoutMs(elapsed));
    rounds++;
    claimed += r.claimed;
    outcomes.push(...r.outcomes);
    const after = Date.now() - started;
    const decision = nextRound({ elapsedMs: after, claimedLast: r.claimed, dueSoon: r.claimed === 0 ? await jobDueSoon(sb) : false });
    if (decision.action === "stop") break;
    if (decision.waitMs > 0) await sleep(decision.waitMs);
  }

  const count = (o: Outcome) => outcomes.filter((x) => x === o).length;
  return {
    watchdog: wd.success && wd.data[0] ? wd.data[0] : { requeued: 0, dead: 0, released_holds: 0 },
    claimed,
    rounds,
    succeeded: count("succeeded"),
    retried: count("retried"),
    dead: count("dead"),
    lost_lease: count("lost_lease"),
  };
}
