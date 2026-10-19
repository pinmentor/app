import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AdminShell } from "@/app/admin/admin-nav";
import { requireAdmin } from "@/lib/admin/guard";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Map result — PinMentor Admin" };

const idSchema = z.string().uuid();
const checkSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["pass", "flag", "fail", "skipped"]),
  summary: z.string(),
  details: z.array(z.unknown()).optional(),
});
const reportSchema = z.object({ verdict: z.enum(["pass", "flag", "fail"]), checks: z.array(checkSchema), note: z.string().optional() });
const runSchema = z.object({
  id: z.string().uuid(), topic: z.string(), locale: z.string(), status: z.string(), stage: z.string(), last_error: z.string().nullable(),
  target_min: z.number(), target_max: z.number(), stats: z.record(z.string(), z.unknown()), report: z.unknown(),
});
const siloSchema = z.object({ id: z.string().uuid(), name: z.string(), size: z.number(), gloss: z.record(z.string(), z.unknown()), position: z.number() });
const itemSchema = z.object({
  id: z.string().uuid(), silo_id: z.string().uuid().nullable(), keyword: z.string(), variants: z.array(z.string()), title: z.string().nullable(), slug: z.string().nullable(),
  article_type: z.string(), list_count: z.number().nullable(), intent: z.string().nullable(), priority: z.coerce.number(), flags: z.array(z.string()), gloss: z.record(z.string(), z.unknown()),
  link_plan: z.record(z.string(), z.unknown()), position: z.number(),
});

const STATUS_CLASS: Record<string, string> = { pass: "pm-pill-succeeded", flag: "pm-pill-running", fail: "pm-pill-dead", skipped: "pm-pill-canceled" };

/** gloss = {keyword:{en,bn}, title:{en,bn}} written by S7; anything else renders as nothing. */
function glossLine(g: Record<string, unknown>, part: "keyword" | "title"): string {
  const p = z.object({ en: z.string().optional(), bn: z.string().optional() }).safeParse(g[part]);
  return p.success ? [p.data.en, p.data.bn].filter(Boolean).join(" · ") : "";
}

export default async function MapResultPage({ params }: { params: Promise<{ id: string }> }) {
  const { role } = await requireAdmin();
  const id = idSchema.safeParse((await params).id);
  if (!id.success) notFound();

  const sb = createAdminClient();
  const runRes = await sb.from("map_runs").select("id, topic, locale, status, stage, last_error, target_min, target_max, stats, report").eq("id", id.data).maybeSingle();
  const run = runSchema.safeParse(runRes.data);
  if (!run.success) notFound();
  const [silosRes, itemsRes] = await Promise.all([
    sb.from("silos").select("id, name, size, gloss, position").eq("map_run_id", id.data).order("position"),
    sb.from("plan_items").select("id, silo_id, keyword, variants, title, slug, article_type, list_count, intent, priority, flags, gloss, link_plan, position").eq("map_run_id", id.data).order("position").limit(1000),
  ]);
  const silos = z.array(siloSchema).safeParse(silosRes.data ?? []);
  const items = z.array(itemSchema).safeParse(itemsRes.data ?? []);
  const report = reportSchema.safeParse(run.data.report);

  return (
    <AdminShell current="maps" role={role}>
      <div className="pm-pagehead">
        <div>
          <h1>{run.data.topic}</h1>
          <p>
            <Link href="/admin/maps">&larr; All runs</Link> · {run.data.locale} · target {run.data.target_min}-{run.data.target_max} · {run.data.status} / {run.data.stage}
            {run.data.last_error ? ` · ${run.data.last_error}` : ""}
          </p>
        </div>
      </div>

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
        {!silos.success || !items.success ? <p className="pm-note pm-note-bad">Could not load the plan.</p> : null}
        {silos.success && items.success && silos.data.length === 0 ? <p className="pm-muted">No plan yet.</p> : null}
        {silos.success && items.success
          ? silos.data.map((s) => {
              const mine = items.data.filter((i) => i.silo_id === s.id);
              return (
                <div key={s.id} style={{ marginBottom: "1.5rem" }}>
                  <h3>
                    {s.name} <span className="pm-muted">({s.size} items{glossLine({ keyword: s.gloss }, "keyword") ? ` · ${glossLine({ keyword: s.gloss }, "keyword")}` : ""})</span>
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
                                {glossLine(i.gloss, "keyword") ? <div className="pm-muted">{glossLine(i.gloss, "keyword")}</div> : null}
                              </td>
                              <td>
                                {i.title ?? ""}
                                {glossLine(i.gloss, "title") ? <div className="pm-muted">{glossLine(i.gloss, "title")}</div> : null}
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
