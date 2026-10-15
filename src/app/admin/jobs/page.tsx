import Link from "next/link";
import { z } from "zod";
import { AdminNav } from "@/app/admin/admin-nav";
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

const STATE_STYLE: Record<string, string> = {
  queued: "text-neutral-700",
  running: "text-blue-700",
  succeeded: "text-green-700",
  dead: "text-red-700 font-medium",
  canceled: "text-neutral-500",
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
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-4 py-10">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Jobs &amp; LLM</h1>
        <span className="text-xs uppercase tracking-wide text-neutral-500">{role}</span>
      </header>
      <AdminNav current="jobs" />

      {flash ? (
        <p role="status" className={flash.ok ? "text-sm text-green-700" : "text-sm text-red-600"}>
          {flash.text}
        </p>
      ) : null}
      {loadFailed ? (
        <p className="text-sm text-red-600">Could not load everything. Check that migrations 0005 and 0006 are applied.</p>
      ) : null}

      <section className="flex flex-wrap gap-3">
        {JOB_STATES.map((s) => (
          <Link
            key={s}
            href={`/admin/jobs?state=${s}`}
            className="min-w-28 rounded-lg border border-neutral-200 px-4 py-3 hover:bg-neutral-50"
          >
            <div className={`text-2xl font-semibold tabular-nums ${STATE_STYLE[s] ?? ""}`}>{countOf(s)}</div>
            <div className="text-xs uppercase tracking-wide text-neutral-500">{s === "dead" ? "dead-letter" : s}</div>
          </Link>
        ))}
        {state !== "all" ? (
          <Link href="/admin/jobs" className="self-center text-sm underline">
            Show all
          </Link>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">LLM, last 24 hours</h2>
        <p className="text-sm text-neutral-600">
          {gate ? (
            gate.allowed ? (
              <>
                Calls allowed. Spent today (UTC): <strong>{usd(gate.spent_today_usd)}</strong>
                {gate.daily_limit_usd !== null ? ` of the ${usd(gate.daily_limit_usd)} daily guard (if enabled).` : "."}
              </>
            ) : (
              <strong className="text-red-700">
                LLM calls are REFUSED ({gate.reason === "kill_switch" ? "kill switch is on" : "daily budget reached"}).
              </strong>
            )
          ) : (
            "Budget status unavailable."
          )}
        </p>
        <div className="overflow-x-auto rounded-lg border border-neutral-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-3 py-2">Provider</th>
                <th className="px-3 py-2">Model</th>
                <th className="px-3 py-2 text-right">Calls</th>
                <th className="px-3 py-2 text-right">Errors</th>
                <th className="px-3 py-2 text-right">Tokens in / out</th>
                <th className="px-3 py-2 text-right">Avg latency</th>
                <th className="px-3 py-2 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {usageRows.map((r) => (
                <tr key={`${r.provider}:${r.model_key}`} className="border-t border-neutral-200">
                  <td className="px-3 py-2">{r.provider}</td>
                  <td className="px-3 py-2">{r.model_key}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.calls}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${r.errors > 0 ? "text-red-700" : ""}`}>{r.errors}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.input_tokens.toLocaleString("en-US")} / {r.output_tokens.toLocaleString("en-US")}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.avg_latency_ms} ms</td>
                  <td className="px-3 py-2 text-right tabular-nums">{usd(r.cost_usd)}</td>
                </tr>
              ))}
              {usageRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-neutral-500">
                    No LLM calls in the last 24 hours.
                  </td>
                </tr>
              ) : (
                <tr className="border-t border-neutral-200 bg-neutral-50 font-medium">
                  <td className="px-3 py-2" colSpan={6}>Total</td>
                  <td className="px-3 py-2 text-right tabular-nums">{usd(totalCost)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {mayEnqueue ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Plumbing test</h2>
          <p className="text-sm text-neutral-600">
            Queues a test job in <em>your own</em> workspace. &ldquo;LLM echo&rdquo; holds 1 credit, makes one real LLM call
            through the router, logs its cost, then commits the credit. A &ldquo;fail&rdquo; job retries once, then lands in the dead-letter list.
          </p>
          <form action={enqueueTestJob} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="key" value={newIdempotencyKey()} />
            <select name="mode" defaultValue="llm" className="rounded border border-neutral-300 px-2 py-1.5 text-sm">
              <option value="llm">LLM echo (1 credit, real API call)</option>
              <option value="ok">No-op (succeeds)</option>
              <option value="fail">No-op (fails, retried once)</option>
              <option value="fail_permanent">No-op (fails permanently)</option>
            </select>
            <button type="submit" className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">
              Queue test job
            </button>
          </form>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">
          Jobs {state === "all" ? "(latest 50)" : `— ${state}`}
        </h2>
        <div className="overflow-x-auto rounded-lg border border-neutral-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">State</th>
                <th className="px-3 py-2 text-right">Attempts</th>
                <th className="px-3 py-2 text-right">Credits</th>
                <th className="px-3 py-2">Created</th>
                <th className="px-3 py-2">Last error</th>
                {mayManage ? <th className="px-3 py-2">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {(jobs.success ? jobs.data : []).map((j) => (
                <tr key={j.id} className="border-t border-neutral-200 align-top">
                  <td className="px-3 py-2">{j.type}</td>
                  <td className={`px-3 py-2 ${STATE_STYLE[j.state] ?? ""}`}>{j.state}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {j.attempts}/{j.max_attempts}
                    {j.retry_count > 0 ? <span className="text-neutral-500"> (+{j.retry_count} manual)</span> : null}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{j.credit_amount}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{j.created_at.slice(0, 16).replace("T", " ")}</td>
                  <td className="px-3 py-2 max-w-xs">
                    {j.last_error_code ? <code className="text-xs">{j.last_error_code}</code> : null}
                    {j.last_error ? <div className="truncate text-xs text-neutral-600" title={j.last_error}>{j.last_error}</div> : null}
                  </td>
                  {mayManage ? (
                    <td className="px-3 py-2">
                      <span className="flex gap-1">
                        {j.state === "dead" ? (
                          <form action={retryJob}>
                            <input type="hidden" name="jobId" value={j.id} />
                            <button type="submit" className="rounded bg-neutral-900 px-2 py-1 text-white">Retry</button>
                          </form>
                        ) : null}
                        {j.state === "dead" || j.state === "queued" ? (
                          <form action={cancelJob}>
                            <input type="hidden" name="jobId" value={j.id} />
                            <button type="submit" className="rounded border border-neutral-300 px-2 py-1">Cancel</button>
                          </form>
                        ) : null}
                      </span>
                    </td>
                  ) : null}
                </tr>
              ))}
              {jobs.success && jobs.data.length === 0 ? (
                <tr>
                  <td colSpan={mayManage ? 7 : 6} className="px-3 py-6 text-center text-neutral-500">
                    No jobs.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
