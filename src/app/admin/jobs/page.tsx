import Link from "next/link";
import { z } from "zod";
import { AdminShell } from "@/app/admin/admin-nav";
import { requireAdmin } from "@/lib/admin/guard";
import {
  budgetRowSchema,
  JOB_STATES,
  jobCountRowSchema,
  jobRowSchema,
  llmUsageRowSchema,
  stateFilterSchema,
} from "@/lib/admin/job-schemas";
import { newIdempotencyKey } from "@/lib/admin/keys";
import { canEnqueueTestJobs, canManageJobs } from "@/lib/admin/roles";
import { createAdminClient } from "@/lib/supabase/admin";
import { cancelJob, enqueueTestJob, retryJob } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Jobs & LLM — PinMentor Admin" };

const FLASH: Record<string, { text: string; ok: boolean }> = {
  retried: { text: "Job re-queued (credits re-reserved). The next tick picks it up.", ok: true },
  canceled: { text: "Job canceled; its credit hold was released.", ok: true },
  enqueued: { text: "Test job queued. It runs on the next tick (within a minute).", ok: true },
  invalid: { text: "Invalid input.", ok: false },
  insufficient: { text: "Not enough credits for that.", ok: false },
  state: { text: "That job is no longer in a state where this action applies.", ok: false },
  forbidden: { text: "Your role cannot do that.", ok: false },
  error: { text: "Something went wrong. Nothing was changed; try again.", ok: false },
};

const PILL: Record<string, string> = {
  queued: "",
  running: "pm-pill-running",
  succeeded: "pm-pill-succeeded",
  dead: "pm-pill-dead",
  canceled: "pm-pill-canceled",
};
const TONE: Record<string, string> = {
  running: "pm-tone-running",
  succeeded: "pm-tone-succeeded",
  dead: "pm-tone-dead",
};

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export default async function AdminJobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { role } = await requireAdmin();
  const raw = await searchParams;
  const state = stateFilterSchema.parse(typeof raw.state === "string" ? raw.state : "all");
  const flash = typeof raw.flash === "string" ? FLASH[raw.flash] : undefined;
  const mayManage = canManageJobs(role);
  const mayEnqueue = canEnqueueTestJobs(role);

  const sb = createAdminClient();
  let filtered = sb
    .from("jobs")
    .select("id, workspace_id, type, state, attempts, max_attempts, retry_count, credit_amount, last_error, last_error_code, run_at, created_at, finished_at");
  if (state !== "all") filtered = filtered.eq("state", state);
  const jobsQuery = filtered.order("created_at", { ascending: false }).limit(50);

  const [countsRes, jobsRes, usageRes, budgetRes] = await Promise.all([
    sb.rpc("admin_job_counts"),
    jobsQuery,
    sb.rpc("admin_llm_usage", { p_hours: 24 }),
    sb.rpc("llm_budget_check"),
  ]);

  const counts = z.array(jobCountRowSchema).safeParse(countsRes.data ?? []);
  const jobs = z.array(jobRowSchema).safeParse(jobsRes.data ?? []);
  const usage = z.array(llmUsageRowSchema).safeParse(usageRes.data ?? []);
  const budget = z.array(budgetRowSchema).safeParse(budgetRes.data ?? []);
  const loadFailed =
    Boolean(countsRes.error || jobsRes.error || usageRes.error || budgetRes.error) ||
    !counts.success || !jobs.success || !usage.success || !budget.success;

  const countOf = (s: string) => (counts.success ? (counts.data.find((c) => c.state === s)?.jobs ?? 0) : 0);
  const gate = budget.success ? budget.data[0] : undefined;
  const usageRows = usage.success ? usage.data : [];
  const totalCost = usageRows.reduce((sum, r) => sum + r.cost_usd, 0);

  return (
    <AdminShell current="jobs" role={role}>
      <div className="pm-pagehead">
        <div>
          <h1>Jobs &amp; LLM</h1>
          <p>Background work, its credit holds, and what the model calls cost.</p>
        </div>
      </div>

      {flash ? (
        <p role="status" className={flash.ok ? "pm-note pm-note-ok" : "pm-note pm-note-bad"}>
          {flash.text}
        </p>
      ) : null}
      {loadFailed ? (
        <p className="pm-note pm-note-bad">Could not load everything. Check that migrations 0005 and 0006 are applied.</p>
      ) : null}

      <div className="pm-section">
        <div className="pm-strip">
          {JOB_STATES.map((s) => (
            <Link key={s} href={`/admin/jobs?state=${s}`} aria-current={state === s ? "true" : undefined}>
              <span className={`pm-strip-n ${TONE[s] ?? ""}`}>{countOf(s)}</span>
              <span className="pm-strip-label">{s === "dead" ? "dead-letter" : s}</span>
            </Link>
          ))}
        </div>
        {state !== "all" ? (
          <p>
            <Link href="/admin/jobs" className="pm-btn pm-btn-quiet pm-btn-xs">
              Show all
            </Link>
          </p>
        ) : null}
      </div>

      <section className="pm-section">
        <h2>LLM, last 24 hours</h2>
        <p>
          {gate ? (
            gate.allowed ? (
              <>
                Calls allowed. Spent today (UTC): <strong>{usd(gate.spent_today_usd)}</strong>
                {gate.daily_limit_usd !== null ? ` of the ${usd(gate.daily_limit_usd)} daily guard (if enabled).` : "."}
              </>
            ) : (
              <strong className="pm-tone-dead">
                LLM calls are REFUSED ({gate.reason === "kill_switch" ? "kill switch is on" : "daily budget reached"}).
              </strong>
            )
          ) : (
            "Budget status unavailable."
          )}
        </p>
        <div className="pm-tablewrap">
          <table className="pm-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Model</th>
                <th className="pm-num">Calls</th>
                <th className="pm-num">Errors</th>
                <th className="pm-num">Tokens in / out</th>
                <th className="pm-num">Avg latency</th>
                <th className="pm-num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {usageRows.map((r) => (
                <tr key={`${r.provider}:${r.model_key}`}>
                  <td>{r.provider}</td>
                  <td>{r.model_key}</td>
                  <td className="pm-num">{r.calls}</td>
                  <td className={`pm-num ${r.errors > 0 ? "pm-tone-dead" : ""}`}>{r.errors}</td>
                  <td className="pm-num">
                    {r.input_tokens.toLocaleString("en-US")} / {r.output_tokens.toLocaleString("en-US")}
                  </td>
                  <td className="pm-num">{r.avg_latency_ms} ms</td>
                  <td className="pm-num">{usd(r.cost_usd)}</td>
                </tr>
              ))}
              {usageRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="pm-empty-row">
                    No LLM calls in the last 24 hours.
                  </td>
                </tr>
              ) : (
                <tr className="pm-total">
                  <td colSpan={6}>Total</td>
                  <td className="pm-num">{usd(totalCost)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {mayEnqueue ? (
        <section className="pm-section">
          <h2>Plumbing test</h2>
          <p>
            Queues a test job in <em>your own</em> workspace. &ldquo;LLM echo&rdquo; holds 1 credit, makes one real LLM call
            through the router, logs its cost, then commits the credit. A &ldquo;fail&rdquo; job retries once, then lands in the dead-letter list.
          </p>
          <form action={enqueueTestJob} className="pm-inline" style={{ gap: "0.5rem" }}>
            <input type="hidden" name="key" value={newIdempotencyKey()} />
            <select name="mode" defaultValue="llm" aria-label="Test job type" className="pm-input" style={{ width: "auto" }}>
              <option value="llm">LLM echo (1 credit, real API call)</option>
              <option value="ok">No-op (succeeds)</option>
              <option value="fail">No-op (fails, retried once)</option>
              <option value="fail_permanent">No-op (fails permanently)</option>
            </select>
            <button type="submit" className="pm-btn pm-btn-brand">
              Queue test job
            </button>
          </form>
        </section>
      ) : null}

      <section className="pm-section">
        <h2>Jobs {state === "all" ? "(latest 50)" : `(${state})`}</h2>
        <div className="pm-tablewrap">
          <table className="pm-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>State</th>
                <th className="pm-num">Attempts</th>
                <th className="pm-num">Credits</th>
                <th>Created</th>
                <th>Last error</th>
                {mayManage ? <th>Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {(jobs.success ? jobs.data : []).map((j) => (
                <tr key={j.id}>
                  <td>{j.type}</td>
                  <td>
                    <span className={`pm-pill ${PILL[j.state] ?? ""}`}>{j.state}</span>
                  </td>
                  <td className="pm-num">
                    {j.attempts}/{j.max_attempts}
                    {j.retry_count > 0 ? <span className="pm-muted"> (+{j.retry_count} manual)</span> : null}
                  </td>
                  <td className="pm-num">{j.credit_amount}</td>
                  <td className="pm-nowrap">{j.created_at.slice(0, 16).replace("T", " ")}</td>
                  <td className="pm-err">
                    {j.last_error_code ? <code>{j.last_error_code}</code> : null}
                    {j.last_error ? <div title={j.last_error}>{j.last_error}</div> : null}
                  </td>
                  {mayManage ? (
                    <td>
                      <div className="pm-inline">
                        {j.state === "dead" ? (
                          <form action={retryJob}>
                            <input type="hidden" name="jobId" value={j.id} />
                            <button type="submit" className="pm-btn pm-btn-brand pm-btn-xs">
                              Retry
                            </button>
                          </form>
                        ) : null}
                        {j.state === "dead" || j.state === "queued" ? (
                          <form action={cancelJob}>
                            <input type="hidden" name="jobId" value={j.id} />
                            <button type="submit" className="pm-btn pm-btn-quiet pm-btn-xs">
                              Cancel
                            </button>
                          </form>
                        ) : null}
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
              {jobs.success && jobs.data.length === 0 ? (
                <tr>
                  <td colSpan={mayManage ? 7 : 6} className="pm-empty-row">
                    No jobs.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </AdminShell>
  );
}
