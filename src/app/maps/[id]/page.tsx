import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { GLOSS_LABEL, GLOSS_MODES, glossLine, parseGlossMode, reportSchema, statusCounts, type GlossMode } from "@/modules/topical-map/review-view";
import { AppFrame } from "../chrome";
import { editItems, reviewItems } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review a map — PinMentor" };

const runSchema = z.object({
  id: z.string().uuid(), topic: z.string(), locale: z.string(), status: z.string(), target_max: z.number(), params: z.record(z.string(), z.unknown()),
  stats: z.record(z.string(), z.unknown()), report: z.unknown(),
});
const siloSchema = z.object({ id: z.string().uuid(), name: z.string(), size: z.number(), gloss: z.record(z.string(), z.unknown()), position: z.number() });
const itemSchema = z.object({
  id: z.string().uuid(), silo_id: z.string().uuid().nullable(), keyword: z.string(), variants: z.array(z.string()), title: z.string().nullable(), article_type: z.string(),
  list_count: z.number().nullable(), status: z.string(), flags: z.array(z.string()), gloss: z.record(z.string(), z.unknown()), link_plan: z.record(z.string(), z.unknown()), position: z.number(),
});
const sizingSchema = z.object({ mode: z.string(), ceiling: z.number(), kept: z.number(), natural: z.number(), trimmed: z.number() });

const PILL: Record<string, string> = { pass: "pm-pill-succeeded", flag: "pm-pill-running", fail: "pm-pill-dead", skipped: "pm-pill-canceled", approved: "pm-pill-succeeded", rejected: "pm-pill-dead", draft: "pm-pill-canceled" };
const FLASH: Record<string, { text: string; bad: boolean }> = {
  blocked: { text: "Approval is blocked: the verification report is red (or missing). Rejecting and going back to draft still work.", bad: true },
  forbidden: { text: "You cannot change this map.", bad: true },
  locked: { text: "Not changed: approved items, group main articles (pillars) and unfinished maps cannot be restructured. Send approved items back to review first.", bad: true },
  gone: { text: "Not changed: an item, variant or group was not found (the page may be out of date). Refresh and try again.", bad: true },
  pick: { text: "Not changed: pick exactly two items for Merge, or at least one item and a target group for Move.", bad: true },
  error: { text: "Something went wrong. Nothing was changed; please try again.", bad: true },
};

export default async function ReviewMapPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ gloss?: string; flash?: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const id = z.string().uuid().safeParse((await params).id);
  if (!id.success) notFound();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/maps/${id.data}`)}`);
  const sp = await searchParams;
  const mode = parseGlossMode(sp.gloss);

  // All reads go through RLS: a map of another workspace is simply not found.
  const runRes = await supabase.from("map_runs").select("id, topic, locale, status, target_max, params, stats, report").eq("id", id.data).maybeSingle();
  const run = runSchema.safeParse(runRes.data);
  if (!run.success) notFound();
  const [silosRes, itemsRes] = await Promise.all([
    supabase.from("silos").select("id, name, size, gloss, position").eq("map_run_id", id.data).order("position"),
    supabase.from("plan_items").select("id, silo_id, keyword, variants, title, article_type, list_count, status, flags, gloss, link_plan, position").eq("map_run_id", id.data).order("position").limit(1000),
  ]);
  const silos = z.array(siloSchema).safeParse(silosRes.data ?? []);
  const items = z.array(itemSchema).safeParse(itemsRes.data ?? []);
  const report = reportSchema.safeParse(run.data.report);
  const sizing = sizingSchema.safeParse(run.data.stats.sizing);
  const counts = items.success ? statusCounts(items.data.map((i) => i.status)) : { draft: 0, approved: 0, rejected: 0 };
  const blocked = run.data.status !== "succeeded" || !report.success || report.data.verdict === "fail";
  const flash = sp.flash ? FLASH[sp.flash] ?? (sp.flash.startsWith("edited-") ? { text: sp.flash === "edited-merge" ? "Merged. The second item is now a variant of the first." : sp.flash === "edited-split" ? "Split. The variant is a new item without a title yet (flag: needs_title)." : "Moved. Links of the affected groups were rebuilt.", bad: false } : sp.flash.startsWith("done-") ? { text: `Done: ${sp.flash.slice(5)} item(s) changed.`, bad: false } : undefined) : undefined;
  const link = (m: GlossMode) => `/maps/${run.data.id}?gloss=${m}`;

  return (
    <AppFrame email={user.email ?? ""}>
      <p>
        <Link href="/maps">&larr; All maps</Link>
      </p>
      <h1>{run.data.topic}</h1>
      <p className="pm-muted">
        {run.data.locale} · {sizing.success ? `${sizing.data.kept} articles${sizing.data.mode === "auto" ? " (auto size)" : ""}${sizing.data.trimmed > 0 ? `, ${sizing.data.trimmed} more found but left out by the limit of ${sizing.data.ceiling}` : ""}` : `up to ${run.data.target_max} articles`} · approved {counts.approved}, rejected {counts.rejected}, to review {counts.draft}
      </p>
      {flash ? <p className={flash.bad ? "pm-note pm-note-bad" : "pm-note"}>{flash.text}</p> : null}

      <section className="pm-section">
        <h2>Checks {report.success ? <span className={`pm-pill ${PILL[report.data.verdict] ?? ""}`}>{report.data.verdict}</span> : null}</h2>
        {!report.success ? <p className="pm-muted">No report for this map.</p> : null}
        {report.success ? (
          <div className="pm-tablewrap">
            <table className="pm-table">
              <thead>
                <tr><th>Check</th><th>Result</th><th>What was found</th></tr>
              </thead>
              <tbody>
                {report.data.checks.map((c) => (
                  <tr key={c.id}>
                    <td className="pm-nowrap">{c.name}</td>
                    <td><span className={`pm-pill ${PILL[c.status] ?? ""}`}>{c.status}</span></td>
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
        ) : null}
        <p className="pm-muted">
          Skipped checks were not verified. A red result blocks approval. Word-list and model checks are estimates, not guarantees.
        </p>
        {blocked ? <p className="pm-note pm-note-bad">Approval is blocked until the report is not red.</p> : null}
      </section>

      <section className="pm-section">
        <h2>Articles</h2>
        <p className="pm-muted">
          Translation next to each keyword and title:{" "}
          {GLOSS_MODES.map((m) => (
            <span key={m}>
              {m === mode ? <strong>{GLOSS_LABEL[m]}</strong> : <Link href={link(m)}>{GLOSS_LABEL[m]}</Link>}
              {m === "both" ? "" : " · "}
            </span>
          ))}
        </p>
        <form action={reviewItems}>
          <input type="hidden" name="run" value={run.data.id} />
          <input type="hidden" name="gloss" value={mode} />
          <button type="submit" name="intent" value="approve_clean" className="pm-btn pm-btn-brand" disabled={blocked}>
            Approve every article without a flag
          </button>
          <span className="pm-muted"> Flagged articles stay for you to decide one by one.</span>
        </form>

        {!silos.success || !items.success ? <p className="pm-note pm-note-bad">Could not load the articles.</p> : null}
        {silos.success && items.success
          ? silos.data.map((s) => {
              const mine = items.data.filter((i) => i.silo_id === s.id);
              const sg = glossLine({ keyword: s.gloss }, "keyword", mode);
              const others = silos.data.filter((o) => o.id !== s.id);
              const variantOptions = mine.filter((i) => i.status !== "approved").flatMap((i) => i.variants.map((v) => ({ value: `${i.id}|${v}`, label: `${v} (from ${i.keyword})` })));
              return (
                <form key={s.id} action={reviewItems} style={{ marginTop: "1.5rem" }}>
                  <input type="hidden" name="run" value={run.data.id} />
                  <input type="hidden" name="gloss" value={mode} />
                  <h3>
                    {s.name} <span className="pm-muted">({s.size} articles{sg ? ` · ${sg}` : ""})</span>
                  </h3>
                  <div className="pm-tablewrap">
                    <table className="pm-table">
                      <thead>
                        <tr><th></th><th>Keyword</th><th>Title</th><th>Type</th><th className="pm-num">N</th><th>Status</th><th>Flags</th></tr>
                      </thead>
                      <tbody>
                        {mine.map((i) => {
                          const pillar = Array.isArray(i.link_plan.children) && i.link_plan.children.length > 0;
                          const kg = glossLine(i.gloss, "keyword", mode);
                          const tg = glossLine(i.gloss, "title", mode);
                          return (
                            <tr key={i.id}>
                              <td><input type="checkbox" name="id" value={i.id} aria-label={`Select ${i.keyword}`} /></td>
                              <td>
                                {pillar ? <strong>{i.keyword}</strong> : i.keyword}
                                {i.variants.length > 0 ? <div className="pm-muted">also: {i.variants.join(", ")}</div> : null}
                                {kg ? <div className="pm-muted">{kg}</div> : null}
                              </td>
                              <td>
                                {i.title ?? ""}
                                {tg ? <div className="pm-muted">{tg}</div> : null}
                              </td>
                              <td>{i.article_type === "B" ? "Product / comparison" : "Ideas / list"}</td>
                              <td className="pm-num">{i.list_count ?? ""}</td>
                              <td><span className={`pm-pill ${PILL[i.status] ?? ""}`}>{i.status}</span></td>
                              <td>{i.flags.join(", ")}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="pm-inline" style={{ gap: "0.5rem", marginTop: "0.5rem" }}>
                    <button type="submit" name="intent" value="approve" className="pm-btn pm-btn-brand pm-btn-sm" disabled={blocked}>Approve selected</button>
                    <button type="submit" name="intent" value="reject" className="pm-btn pm-btn-ghost pm-btn-sm">Reject selected</button>
                    <button type="submit" name="intent" value="draft" className="pm-btn pm-btn-quiet pm-btn-sm">Back to review</button>
                  </div>
                  <details style={{ marginTop: "0.5rem" }}>
                    <summary className="pm-muted">Edit structure: merge, move, split</summary>
                    <div className="pm-inline" style={{ gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
                      <button type="submit" formAction={editItems} name="intent" value="merge" className="pm-btn pm-btn-ghost pm-btn-sm" disabled={run.data.status !== "succeeded"}>
                        Merge the 2 selected
                      </button>
                      <span className="pm-muted">(the upper one stays, the lower becomes its variant)</span>
                    </div>
                    {others.length > 0 ? (
                      <div className="pm-inline" style={{ gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
                        <label>
                          Move selected to{" "}
                          <select name="silo" defaultValue={others[0]!.id}>
                            {others.map((o) => (
                              <option key={o.id} value={o.id}>{o.name}</option>
                            ))}
                          </select>
                        </label>
                        <button type="submit" formAction={editItems} name="intent" value="move" className="pm-btn pm-btn-ghost pm-btn-sm">Move</button>
                      </div>
                    ) : null}
                    {variantOptions.length > 0 ? (
                      <div className="pm-inline" style={{ gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
                        <label>
                          Make a variant its own article{" "}
                          <select name="variant" defaultValue={variantOptions[0]!.value}>
                            {variantOptions.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                        </label>
                        <button type="submit" formAction={editItems} name="intent" value="split" className="pm-btn pm-btn-ghost pm-btn-sm">Split</button>
                      </div>
                    ) : null}
                    <p className="pm-muted">Not allowed for approved items or for the main article of a group. The new article from a split has no title yet.</p>
                  </details>
                </form>
              );
            })
          : null}
        <p className="pm-muted">Bold = the main article of its group (it links to every other article of the group). Approving writes and publishes nothing yet; it only marks what you accept.</p>
      </section>
    </AppFrame>
  );
}
