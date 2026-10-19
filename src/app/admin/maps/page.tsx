import Link from "next/link";
import { z } from "zod";
import { AdminShell } from "@/app/admin/admin-nav";
import { newIdempotencyKey } from "@/lib/admin/keys";
import { requireAdmin } from "@/lib/admin/guard";
import { canEnqueueTestJobs } from "@/lib/admin/roles";
import { createAdminClient } from "@/lib/supabase/admin";
import { cancelRun, startRun } from "./actions";
import { LOCALE_OPTIONS, runListRowSchema } from "./schemas";

export const dynamic = "force-dynamic";
export const metadata = { title: "Topical maps — PinMentor Admin" };

const FLASH: Record<string, { text: string; ok: boolean }> = {
  started: { text: "Map run started. It advances one step per minute; refresh to follow it.", ok: true },
  canceled: { text: "Run canceled and its credits released.", ok: true },
  no_credits: { text: "Not enough credits in your workspace for this size. Grant yourself credits on the Users page.", ok: false },
  invalid: { text: "Check the form: a topic, a locale, and a target between 10 and 1000 (min not above max).", ok: false },
  forbidden: { text: "Only a superadmin can start or cancel runs here, and only in their own workspace.", ok: false },
  error: { text: "Something went wrong. Nothing was changed; try again.", ok: false },
};

const PILL: Record<string, string> = {
  running: "pm-pill-running",
  queued: "pm-pill-running",
  succeeded: "pm-pill-succeeded",
  failed: "pm-pill-dead",
  canceled: "pm-pill-canceled",
};

/** Same formula as the SQL map_credit_cost(): shown to the admin before they press start. */
const cost = (n: number) => 10 + 5 * Math.ceil(n / 25);

export default async function MapsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { role } = await requireAdmin();
  const raw = await searchParams;
  const mayRun = canEnqueueTestJobs(role);
  const flash = typeof raw.flash === "string" ? FLASH[raw.flash] : undefined;

  const res = await createAdminClient().rpc("admin_map_run_list", { p_limit: 30 });
  const runs = z.array(runListRowSchema).safeParse(res.data ?? []);

  return (
    <AdminShell current="maps" role={role}>
      <div className="pm-pagehead">
        <div>
          <h1>Topical maps</h1>
          <p>
            Runs the whole pipeline for a topic: facets, candidates, normalise, semantic dedup, intent and type, scoring, silos,
            titles and slugs, link plan, and the verification report. Open a finished run to see its report and plan.
          </p>
        </div>
      </div>

      {flash ? (
        <p role="status" className={flash.ok ? "pm-note pm-note-ok" : "pm-note pm-note-bad"}>
          {flash.text}
        </p>
      ) : null}
      {res.error || !runs.success ? <p className="pm-note pm-note-bad">Could not load the runs.</p> : null}

      {mayRun ? (
        <section className="pm-section">
          <h2>Start a run</h2>
          <p>
            Credits are held from <em>your own</em> workspace when you start, spent when the run succeeds and given back if it
            fails or is canceled. Cost: 10 + 5 &times; (target max / 25, rounded up). For example 100 items = {cost(100)}, 500 items = {cost(500)}.
          </p>
          <form action={startRun} className="pm-inline" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
            <input type="hidden" name="key" value={newIdempotencyKey()} />
            <input name="topic" required minLength={2} maxLength={200} placeholder="Topic, e.g. peinados" aria-label="Topic" className="pm-input" style={{ width: "16rem" }} />
            <select name="locale" defaultValue="es-MX" aria-label="Locale" className="pm-input" style={{ width: "auto" }}>
              {LOCALE_OPTIONS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <input name="targetMin" type="number" min={10} max={1000} defaultValue={20} aria-label="Target min" className="pm-input pm-input-sm" style={{ width: "5.5rem" }} />
            <input name="targetMax" type="number" min={10} max={1000} defaultValue={50} aria-label="Target max" className="pm-input pm-input-sm" style={{ width: "5.5rem" }} />
            <select name="mode" defaultValue="fast" aria-label="Mode" className="pm-input" style={{ width: "auto" }}>
              <option value="fast">Fast</option>
              <option value="economy">Economy</option>
            </select>
            <button type="submit" className="pm-btn pm-btn-brand">
              Start run
            </button>
          </form>
        </section>
      ) : null}

      <section className="pm-section">
        <h2>Recent runs</h2>
        <div className="pm-tablewrap">
          <table className="pm-table">
            <thead>
              <tr>
                <th>Topic</th>
                <th>Status</th>
                <th>Stage</th>
                <th className="pm-num">Candidates</th>
                <th className="pm-num">Primaries</th>
                <th className="pm-num">Credits</th>
                <th>Started</th>
                <th>Last error</th>
                {mayRun ? <th>Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {(runs.success ? runs.data : []).map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/admin/maps/${r.id}`}>{r.topic}</Link> <span className="pm-muted">({r.locale}, ≤{r.target_max})</span>
                  </td>
                  <td>
                    <span className={`pm-pill ${PILL[r.status] ?? ""}`}>{r.status}</span>
                  </td>
                  <td>{r.stage}</td>
                  <td className="pm-num">{r.candidates}</td>
                  <td className="pm-num">{r.primaries}</td>
                  <td className="pm-num">{r.credit_amount}</td>
                  <td className="pm-nowrap">{r.created_at.slice(0, 16).replace("T", " ")}</td>
                  <td>{r.last_error ?? ""}</td>
                  {mayRun ? (
                    <td>
                      {r.status === "queued" || r.status === "running" ? (
                        <form action={cancelRun}>
                          <input type="hidden" name="id" value={r.id} />
                          <button type="submit" className="pm-btn pm-btn-ghost pm-btn-xs">
                            Cancel
                          </button>
                        </form>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
              {runs.success && runs.data.length === 0 ? (
                <tr>
                  <td colSpan={mayRun ? 9 : 8} className="pm-empty-row">
                    No runs yet.
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
