import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { describeFailure, handlers, JobError } from "./handlers";

/**
 * One tick of the worker: watchdog -> claim -> run -> complete/fail. Called every minute by /api/jobs/tick
 * (pg_cron -> pg_net). All state lives in Postgres (job_* functions), so a tick can die anywhere safely:
 * the lease expires and the watchdog re-queues the job.
 */

const MAX_JOBS_PER_TICK = 5;
const LEASE_SECONDS = 90;
const HANDLER_TIMEOUT_MS = 50_000; // keeps one step under the 60s function limit
// Per-provider running-job caps (job_claim). Tune here or move to feature_flags later.
const PROVIDER_LIMITS = { anthropic: 4, openai: 4, gemini: 4 };

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

export async function runTick(): Promise<TickSummary> {
  const sb = createAdminClient();
  const worker = `tick-${randomUUID().slice(0, 8)}`;

  const wdRes = await sb.rpc("job_watchdog");
  const wd = watchdogSchema.safeParse(wdRes.data);
  if (wdRes.error) console.error("job_watchdog failed:", wdRes.error.code ?? "no_code");

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
          HANDLER_TIMEOUT_MS,
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

  const count = (o: Outcome) => outcomes.filter((x) => x === o).length;
  return {
    watchdog: wd.success && wd.data[0] ? wd.data[0] : { requeued: 0, dead: 0, released_holds: 0 },
    claimed: claimed.data.length,
    succeeded: count("succeeded"),
    retried: count("retried"),
    dead: count("dead"),
    lost_lease: count("lost_lease"),
  };
}
