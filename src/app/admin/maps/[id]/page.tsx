import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AdminShell } from "@/app/admin/admin-nav";
import { requireAdmin } from "@/lib/admin/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { GLOSS_LABEL, GLOSS_MODES, glossLine, parseGlossMode, reportSchema, type GlossMode } from "@/modules/topical-map/review-view";
import { formatSeconds, stageDurations, totalSeconds } from "@/modules/topical-map/timeline";

export const dynamic = "force-dynamic";
export const metadata = { title: "Map result — PinMentor Admin" };

const idSchema = z.string().uuid();
const runSchema = z.object({
  id: z.string().uuid(), topic: z.string(), locale: z.string(), status: z.string(), stage: z.string(), last_error: z.string().nullable(),
  created_at: z.string(), finished_at: z.string().nullable(),
  target_min: z.number(), target_max: z.number(), params: z.record(z.string(), z.unknown()), stats: z.record(z.string(), z.unknown()), report: z.unknown(),
});
const siloSchema = z.object({ id: z.string().uuid(), name: z.string(), size: z.number(), gloss: z.record(z.string(), z.unknown()), position: z.number() });
const itemSchema = z.object({
  id: z.string().uuid(), silo_id: z.string().uuid().nullable(), keyword: z.string(), variants: z.array(z.string()), title: z.string().nullable(), slug: z.string().nullable(),
  article_type: z.string(), list_count: z.number().nullable(), intent: z.string().nullable(), priority: z.coerce.number(), flags: z.array(z.string()), gloss: z.record(z.string(), z.unknown()),
  link_plan: z.record(z.string(), z.unknown()), position: z.number(),
});

const STATUS_CLASS: Record<string, string> = { pass: "pm-pill-succeeded", flag: "pm-pill-running", fail: "pm-pill-dead", skipped: "pm-pill-canceled" };

export default async function MapResultPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ gloss?: string }> }) {
  const { role } = await requireAdmin();
  const id = idSchema.safeParse((await params).id);
  const mode: GlossMode = parseGlossMode((await searchParams).gloss);
  if (!id.success) notFound();

  const sb = createAdminClient();
  const runRes = await sb.from("map_runs").select("id, topic, locale, status, stage, last_error, created_at, finished_at, target_min, target_max, params, stats, report").eq("id", id.data).maybeSingle();
  const run = runSchema.safeParse(runRes.data);
  if (!run.success) notFound();
  const [silosRes, itemsRes] = await Promise.all([
    sb.from("silos").select("id, name, size, gloss, position").eq("map_run_id", id.data).order("position"),
    sb.from("plan_items").select("id, silo_id, keyword, variants, title, slug, article_type, list_count, intent, priority, flags, gloss, link_plan, position").eq("map_run_id", id.data).order("position").limit(1000),
  ]);
  const silos = z.array(siloSchema).safeParse(silosRes.data ?? []);
  const items = z.array(itemSchema).safeParse(itemsRes.data ?? []);
  const report = reportSchema.safeParse(run.data.report);
  const timing = stageDurations(run.data.created_at, run.data.stats.timeline, run.data.finished_at);
  const total = totalSeconds(run.data.created_at, run.data.finished_at);
  const sizing = z
    .object({ mode: z.string(), ceiling: z.number(), kept: z.number(), natural: z.number(), trimmed: z.number(), facets: z.number().optional(), values_total: z.number().optional(), values_explored: z.number().optional(), expansion_calls: z.number().optional() })
    .safeParse(run.data.stats.sizing);

  return (
    <AdminShell current="maps" role={role}>
      <div className="pm-pagehead">
        <div>
          <h1>{run.data.topic}</h1>
          <p>
            <Link href="/admin/maps">&larr; All runs</Link> · {run.data.locale} · {run.data.params.size === "auto" ? `auto size, ceiling ${run.data.target_max}` : `target ${run.data.target_min}-${run.data.target_max}`} · {run.data.status} / {run.data.stage}
            {run.data.last_error ? ` · ${run.data.last_error}` : ""}
          </p>
        </div>
      </div>

      <section className="pm-section">
        <h2>Size and timing</h2>
        {sizing.success ? (
          <p>
            {sizing.data.mode === "auto" ? (
              <>
                <strong>Auto size:</strong> the topic produced {sizing.data.natural} distinct articles; {sizing.data.kept} kept
                {sizing.data.trimmed > 0 ? `, ${sizing.data.trimmed} lower-priority ones left out because the ceiling is ${sizing.data.ceiling}` : ` (ceiling ${sizing.data.ceiling} not reached)`}.
              </>
            ) : (
              <>
                <strong>Custom size:</strong> {sizing.data.kept} articles kept, {sizing.data.trimmed} over the maximum {sizing.data.ceiling} left out.
              </>
            )}
            {sizing.data.values_total !== undefined && sizing.data.values_explored !== undefined
              ? ` Explored ${sizing.data.values_explored} of ${sizing.data.values_total} facet values in ${sizing.data.expansion_calls ?? "?"} keyword calls.`
              : ""}
          </p>
        ) : (
          <p className="pm-muted">No size explanation yet.</p>
        )}
        {timing.length > 0 ? (
          <p>
            <strong>Time:</strong> {total !== null ? formatSeconds(total) : "running"} in total ·{" "}
            {timing.map((t) => `${t.stage.replace(/^s\d+_/, "")} ${formatSeconds(t.seconds)}`).join(" · ")}
          </p>
        ) : null}
        <p className="pm-muted">Stage times include the wait for the worker. The result is only a measurement; it does not change anything.</p>
      </section>

      <section className="pm-section">
        <h2>Verification report {report.success ? <span className={`pm-pill ${STATUS_CLASS[report.data.verdict === "flag" ? "flag" : report.data.verdict] ?? ""}`}>{report.data.verdict}</span> : null}</h2>
        {!report.success ? <p className="pm-muted">No report yet (the run has not reached the last stage).</p> : null}
        {report.success ? (
          <>
            <div className="pm-tablewrap">
              <table className="pm-table">
                <thead>
                  <tr><th>Check</th><th>Result</th><th>What was found</th></tr>
                </thead>
                <tbody>
                  {report.data.checks.map((c) => (
                    <tr key={c.id}>
                      <td className="pm-nowrap">{c.id} {c.name}</td>
                      <td><span className={`pm-pill ${STATUS_CLASS[c.status] ?? ""}`}>{c.status}</span></td>
                      <td>
                        {c.summary}
                        {c.details && c.details.length > 0 ? (
                          <details>
                            <summary className="pm-muted">{c.details.length} details</summary>
                            <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.8rem" }}>{JSON.stringify(c.details, null, 1)}</pre>
                          </details>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {report.data.note ? <p className="pm-note pm-note-bad">{report.data.note}</p> : null}
            <p className="pm-muted">A red report keeps every item in draft. Word-list checks (V7) and the model audits (V5, V8) are estimates, not guarantees.</p>
          </>
        ) : null}
      </section>

      <section className="pm-section">
        <h2>Silos and items</h2>
        <p className="pm-muted">
          Translation next to each keyword and title:{" "}
          {GLOSS_MODES.map((m) => (
            <span key={m}>
              {m === mode ? <strong>{GLOSS_LABEL[m]}</strong> : <Link href={`/admin/maps/${run.data.id}?gloss=${m}`}>{GLOSS_LABEL[m]}</Link>}
              {m === "both" ? "" : " · "}
            </span>
          ))}
        </p>
        {!silos.success || !items.success ? <p className="pm-note pm-note-bad">Could not load the plan.</p> : null}
        {silos.success && items.success && silos.data.length === 0 ? <p className="pm-muted">No plan yet.</p> : null}
        {silos.success && items.success
          ? silos.data.map((s) => {
              const mine = items.data.filter((i) => i.silo_id === s.id);
              return (
                <div key={s.id} style={{ marginBottom: "1.5rem" }}>
                  <h3>
                    {s.name} <span className="pm-muted">({s.size} items{glossLine({ keyword: s.gloss }, "keyword", mode) ? ` · ${glossLine({ keyword: s.gloss }, "keyword", mode)}` : ""})</span>
                  </h3>
                  <div className="pm-tablewrap">
                    <table className="pm-table">
                      <thead>
                        <tr><th>Keyword</th><th>Title</th><th>Slug</th><th>Type</th><th className="pm-num">N</th><th>Intent</th><th className="pm-num">Priority</th><th>Flags</th></tr>
                      </thead>
                      <tbody>
                        {mine.map((i) => {
                          const pillar = Array.isArray(i.link_plan.children) && i.link_plan.children.length > 0;
                          return (
                            <tr key={i.id}>
                              <td>
                                {pillar ? <strong>{i.keyword}</strong> : i.keyword}
                                {i.variants.length > 0 ? <div className="pm-muted">+ {i.variants.join(", ")}</div> : null}
                                {glossLine(i.gloss, "keyword", mode) ? <div className="pm-muted">{glossLine(i.gloss, "keyword", mode)}</div> : null}
                              </td>
                              <td>
                                {i.title ?? ""}
                                {glossLine(i.gloss, "title", mode) ? <div className="pm-muted">{glossLine(i.gloss, "title", mode)}</div> : null}
                              </td>
                              <td className="pm-nowrap">{i.slug ?? ""}</td>
                              <td>{i.article_type}</td>
                              <td className="pm-num">{i.list_count ?? ""}</td>
                              <td>{i.intent ?? ""}</td>
                              <td className="pm-num">{i.priority}</td>
                              <td>{i.flags.join(", ")}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })
          : null}
        <p className="pm-muted">Bold = silo pillar (links to every item of its silo). Priority is an estimate: demand is an LLM guess and competition is neutral until a SERP provider is connected.</p>
      </section>
    </AdminShell>
  );
}
