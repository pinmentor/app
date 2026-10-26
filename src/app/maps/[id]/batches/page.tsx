import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { clampBatchSize, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE, MIN_BATCH_SIZE } from "@/modules/topical-map/batching";
import { AppFrame } from "../../chrome";
import { MapTabs } from "../../map-tabs";
import { NextStepCard } from "../../next-step-card";
import { loadMap, nextInputOf, suggestFor } from "../load";
import { progressCounts } from "@/modules/articles/progress";
import { lightOf } from "@/modules/articles/review";
import { changeBatch, createAutoBatches, createManualBatch, runBatch, sendBatchToWordPress, stopBatch } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Batches — PinMentor" };

const FLASH: Record<string, { text: string; bad: boolean }> = {
  locked: { text: "Not changed: the map is not finished, an article is no longer approved or already in a batch, or the batch has started. Refresh and try again.", bad: true },
  gone: { text: "Not changed: an article or batch was not found (the page may be out of date). Refresh and try again.", bad: true },
  forbidden: { text: "You cannot change this map.", bad: true },
  pick: { text: "Not changed: give the batch a name and pick between 1 and 100 articles.", bad: true },
  nothing: { text: "No approved article is waiting for a batch. Approve articles on the Review tab first.", bad: true },
  norate: { text: "Writing cannot start yet: the price for writing an article has not been set. It is set by the PinMentor team; nothing was spent.", bad: true },
  credits: { text: "Not enough credits to write this batch. The credits needed are held when it starts; nothing was spent. Add credits or take some articles out of the batch.", bad: true },
  error: { text: "Something went wrong. Nothing was changed; please try again.", bad: true },
  wp_invalid: { text: "Not queued: check the start date, the number per day and the time window.", bad: true },
  wp_date: { text: "Not queued: choose a start date that is today or later.", bad: true },
  wp_window: { text: "Not queued: the time window is too short for that many articles per day (at least 10 minutes each).", bad: true },
};
const PILL: Record<string, string> = { planned: "", running: "pm-pill-running", completed: "pm-pill-succeeded", canceled: "pm-pill-canceled" };
const STATUS_TEXT: Record<string, string> = { planned: "ready to write", running: "writing", completed: "done", canceled: "cancelled" };
const LIGHT_PILL = { green: "pm-pill-succeeded", yellow: "pm-pill-warn", red: "pm-pill-dead" } as const;

function flashOf(code: string | undefined): { text: string; bad: boolean } | undefined {
  if (!code) return undefined;
  if (FLASH[code]) return FLASH[code];
  const run = /^(started|stopped)-(\d+)$/.exec(code);
  if (run) {
    const k = Number(run[2]);
    return { text: run[1] === "started" ? `Writing started for ${k} article${k === 1 ? "" : "s"}. Refresh this page to see progress; you can leave and come back.` : `Writing stopped. ${k} unfinished article${k === 1 ? " was" : "s were"} cancelled and approved again; finished articles are kept.`, bad: false };
  }
  const q = /^wp_queued-(\d+)-(\d+)$/.exec(code);
  if (q) {
    const k = Number(q[1]);
    const s = Number(q[2]);
    return { text: `Sending ${k} article${k === 1 ? "" : "s"} to WordPress in the background${s ? ` (${s} left out: red, or already sent)` : ""}. Refresh in a minute to see the result for each one.`, bad: false };
  }
  const nn = /^wp_none-(\d+)$/.exec(code);
  if (nn) return { text: "Nothing to send: every ready article here is red or already sent to WordPress.", bad: true };
  const m = /^(created|canceled|removed)-(\d+)$/.exec(code);
  if (!m) return undefined;
  const n = Number(m[2]);
  return {
    text: m[1] === "created" ? `Created ${n} batch${n === 1 ? "" : "es"}. The articles in them are now marked "in a batch".` : m[1] === "canceled" ? `Batch cancelled. ${n} article${n === 1 ? " is" : "s are"} approved again and free for another batch.` : `${n} article${n === 1 ? "" : "s"} taken out of the batch and approved again.`,
    bad: false,
  };
}

export default async function BatchesPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ size?: string; flash?: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const id = z.string().uuid().safeParse((await params).id);
  if (!id.success) notFound();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/maps/${id.data}/batches`)}`);
  const sp = await searchParams;
  const size = clampBatchSize(sp.size ?? DEFAULT_BATCH_SIZE);

  const map = await loadMap(supabase, id.data);
  if (!map) notFound();
  const finished = map.run.status === "succeeded";
  const suggestions = suggestFor(map, size);
  const free = map.items.filter((i) => i.status === "approved" && !i.batch_id);
  const byId = new Map(map.items.map((i) => [i.id, i]));
  const siloName = new Map(map.silos.map((s) => [s.id, s.name]));
  const open = map.batches.filter((b) => b.status !== "canceled");
  const canceled = map.batches.filter((b) => b.status === "canceled");
  const flash = flashOf(sp.flash);
  const wpRes = await supabase.from("articles").select("id, wp_status, wp_when, wp_error").eq("map_run_id", map.run.id);
  const wpOf = new Map(((wpRes.data ?? []) as { id: string; wp_status: string | null; wp_when: string | null; wp_error: string | null }[]).map((x) => [x.id, x]));
  const today = new Date().toISOString().slice(0, 10);
  const firstOfSilo = new Set<string>();

  return (
    <AppFrame email={user.email ?? ""}>
      <p>
        <Link href="/maps">&larr; All maps</Link>
      </p>
      <h1>{map.run.topic}</h1>
      <MapTabs id={map.run.id} current="batches" />
      {flash ? <p className={flash.bad ? "pm-note pm-note-bad" : "pm-note"}>{flash.text}</p> : null}
      <NextStepCard runId={map.run.id} input={nextInputOf(map)} />

      {open.length > 0 ? (
        <section className="pm-section">
          <h2>Your batches</h2>
          {open.map((b) => {
            const mine = map.items.filter((i) => i.batch_id === b.id);
            const planned = b.status === "planned";
            const arts = map.articles.filter((a) => a.batch_id === b.id);
            const pc = progressCounts(arts.map((a) => a.status));
            const artOf = new Map(arts.map((a) => [a.plan_item_id, a]));
            // a finished or running batch lists its articles (some items have left the batch, so show the articles themselves)
            const rows = planned ? mine.map((i) => ({ id: i.id, keyword: i.keyword, title: i.title, status: i.status })) : arts.map((a) => { const it = map.items.find((x) => x.id === a.plan_item_id); return { id: a.plan_item_id, keyword: it?.keyword ?? "", title: it?.title ?? null, status: a.status }; });
            const readyArts = arts.filter((x) => x.status === "ready");
            const notSent = readyArts.filter((x) => !wpOf.get(x.id)?.wp_status).length;
            const greens = readyArts.filter((x) => x.qa.verdict !== "fail" && ["draft", undefined, null].includes(wpOf.get(x.id)?.wp_status)).length;
            return (
              <div key={b.id}>
              <form action={changeBatch} className="pm-batchcard">
                <input type="hidden" name="run" value={map.run.id} />
                <input type="hidden" name="batch" value={b.id} />
                <div className="pm-batchcard-head">
                  <h3>
                    {b.name} <span className={`pm-pill ${PILL[b.status] ?? ""}`}>{STATUS_TEXT[b.status] ?? b.status}</span>
                  </h3>
                  <span className="pm-inline" style={{ gap: "0.5rem" }}>
                    <span className="pm-muted">
                      {planned ? `${mine.length} article${mine.length === 1 ? "" : "s"}` : `${pc.ready} ready${pc.open ? ` · ${pc.open} writing` : ""}${pc.failed ? ` · ${pc.failed} failed` : ""}${pc.canceled ? ` · ${pc.canceled} cancelled` : ""}`}
                      {b.status === "completed" && typeof b.stats.charged === "number" ? ` · ${b.stats.charged} credit${b.stats.charged === 1 ? "" : "s"} charged` : ""}
                    </span>
                    {planned ? <button type="submit" formAction={runBatch} className="pm-btn pm-btn-primary pm-btn-sm" disabled={!finished}>Write this batch</button> : null}
                    {b.status === "running" ? <button type="submit" formAction={stopBatch} className="pm-btn pm-btn-quiet pm-btn-sm">Stop</button> : null}
                  </span>
                </div>
                <details open={!planned}>
                  <summary>{planned ? "Show the articles / change this batch" : "Show the articles"}</summary>
                  <div className="pm-tablewrap" style={{ marginTop: "0.5rem" }}>
                    <table className="pm-table">
                      <tbody>
                        {rows.map((i) => {
                          const a = artOf.get(i.id);
                          const l = lightOf(a?.qa.verdict);
                          return (
                            <tr key={i.id}>
                              <td>{planned ? <input type="checkbox" name="id" value={i.id} aria-label={`Select ${i.keyword}`} /> : null}</td>
                              <td>{i.title ?? i.keyword}</td>
                              <td className="pm-nowrap">
                                {a?.status === "ready" ? (
                                  <>
                                    <span className={`pm-pill ${LIGHT_PILL[l]}`}>{l}</span> <Link href={`/maps/${map.run.id}/articles/${a.id}`}>Read</Link>
                                    {(() => { const w = wpOf.get(a.id); return w?.wp_error ? <span className="pm-muted"> · WP failed ({w.wp_error})</span> : w?.wp_status ? <span className="pm-muted"> · WP {w.wp_status === "publish" ? "published" : w.wp_status === "future" ? `scheduled${w.wp_when ? ` ${w.wp_when.replace("T", " ")}` : ""}` : "draft"}</span> : null; })()}
                                  </>
                                ) : (
                                  <span className="pm-muted">{planned ? "" : i.status}</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {planned ? (
                    <div className="pm-inline" style={{ gap: "0.5rem", marginTop: "0.5rem" }}>
                      <button type="submit" name="intent" value="remove" className="pm-btn pm-btn-ghost pm-btn-sm">Take selected out</button>
                      <button type="submit" name="intent" value="cancel" className="pm-btn pm-btn-ghost pm-btn-sm">Cancel this batch</button>
                    </div>
                  ) : null}
                </details>
              </form>
              {b.status === "completed" && readyArts.length > 0 ? (
                <div className="pm-wpbox">
                  <p className="pm-muted" style={{ margin: 0 }}>WordPress: {readyArts.length - notSent} of {readyArts.length} sent.{notSent > 0 ? ` ${notSent} not sent yet.` : ""}</p>
                  {notSent > 0 ? (
                    <form action={sendBatchToWordPress} style={{ marginTop: "0.6rem" }}>
                      <input type="hidden" name="run" value={map.run.id} />
                      <input type="hidden" name="batch" value={b.id} />
                      <button type="submit" name="plan" value="drafts" className="pm-btn pm-btn-primary">Save {notSent} article{notSent === 1 ? "" : "s"} in WordPress as drafts</button>
                    </form>
                  ) : null}
                  {greens > 0 ? (
                    <details className="pm-more">
                      <summary>Or publish them gradually</summary>
                      <form action={sendBatchToWordPress} className="pm-inline" style={{ gap: "0.6rem", marginTop: "0.5rem", alignItems: "end" }}>
                        <input type="hidden" name="run" value={map.run.id} />
                        <input type="hidden" name="batch" value={b.id} />
                        <input type="hidden" name="plan" value="spread" />
                        <label className="pm-field">Start on<input name="start" type="date" required defaultValue={today} className="pm-input" /></label>
                        <label className="pm-field">Per day<input name="per_day" type="number" min={1} max={10} defaultValue={3} className="pm-input" style={{ width: "5rem" }} /></label>
                        <label className="pm-field">From<input name="from" type="time" defaultValue="09:00" className="pm-input" /></label>
                        <label className="pm-field">Until<input name="until" type="time" defaultValue="18:00" className="pm-input" /></label>
                        <button type="submit" className="pm-btn">Schedule {greens}</button>
                      </form>
                      <p className="pm-muted">Times are your WordPress site&apos;s own clock. Red articles and ones already published or scheduled are left out. Each article is sent in the background and takes a few seconds.</p>
                    </details>
                  ) : null}
                </div>
              ) : null}
              </div>
            );
          })}
        </section>
      ) : null}

      <details className="pm-more">
        <summary>More options: batch size, your own batch</summary>

        <h3>Suggested batches</h3>
        <form method="get" className="pm-inline" style={{ gap: "0.5rem" }}>
          <label>
            Articles per batch{" "}
            <input className="pm-input pm-input-sm" type="number" name="size" min={MIN_BATCH_SIZE} max={MAX_BATCH_SIZE} defaultValue={size} style={{ width: "5rem" }} />
          </label>
          <button type="submit" className="pm-btn pm-btn-ghost pm-btn-sm">Update</button>
          <span className="pm-muted">{MIN_BATCH_SIZE}–{MAX_BATCH_SIZE}, default {DEFAULT_BATCH_SIZE}</span>
        </form>
        {suggestions.length === 0 ? (
          <p className="pm-muted" style={{ marginTop: "0.75rem" }}>No approved article is waiting for a batch.</p>
        ) : (
          <>
            <div className="pm-tablewrap" style={{ marginTop: "0.75rem" }}>
              <table className="pm-table">
                <thead>
                  <tr><th>Batch</th><th className="pm-num">Articles</th><th>Starts with</th><th></th></tr>
                </thead>
                <tbody>
                  {suggestions.map((b) => {
                    const first = byId.get(b.itemIds[0] ?? "");
                    const canNext = b.siloId !== null && !firstOfSilo.has(b.siloId);
                    if (b.siloId) firstOfSilo.add(b.siloId);
                    return (
                      <tr key={`${b.siloId}-${b.name}`}>
                        <td>
                          {b.name}
                          {b.pillarPending ? <div className="pm-muted">its main article is not approved yet</div> : null}
                        </td>
                        <td className="pm-num">{b.itemIds.length}</td>
                        <td>{b.hasPillar ? <strong>{first?.keyword}</strong> : first?.keyword}{b.hasPillar ? <span className="pm-muted"> (main article)</span> : null}</td>
                        <td className="pm-nowrap">
                          {canNext ? (
                            <form action={createAutoBatches}>
                              <input type="hidden" name="run" value={map.run.id} />
                              <input type="hidden" name="size" value={size} />
                              <input type="hidden" name="silo" value={b.siloId ?? ""} />
                              <button type="submit" name="intent" value="next" className="pm-btn pm-btn-ghost pm-btn-sm" disabled={!finished}>Create this batch</button>
                            </form>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <form action={createAutoBatches} style={{ marginTop: "0.75rem" }}>
              <input type="hidden" name="run" value={map.run.id} />
              <input type="hidden" name="size" value={size} />
              <button type="submit" name="intent" value="all" className="pm-btn pm-btn-quiet pm-btn-sm" disabled={!finished}>
                Create all {suggestions.length} suggested batch{suggestions.length === 1 ? "" : "es"} at this size
              </button>
            </form>
          </>
        )}

        <h3 style={{ marginTop: "1.5rem" }}>Your own batch</h3>
        {free.length === 0 ? (
          <p className="pm-muted">No approved article is free.</p>
        ) : (
          <form action={createManualBatch}>
            <input type="hidden" name="run" value={map.run.id} />
            <div className="pm-inline" style={{ gap: "0.5rem", marginBottom: "0.5rem" }}>
              <label>
                Name <input className="pm-input pm-input-sm" name="name" maxLength={120} required placeholder="e.g. Summer ideas" />
              </label>
              <button type="submit" className="pm-btn pm-btn-quiet pm-btn-sm" disabled={!finished}>Create batch from selected</button>
              <span className="pm-muted">Tick 1–100 articles below.</span>
            </div>
            <div className="pm-tablewrap">
              <table className="pm-table">
                <thead>
                  <tr><th></th><th>Keyword</th><th>Title</th><th>Group</th></tr>
                </thead>
                <tbody>
                  {free.map((i) => (
                    <tr key={i.id}>
                      <td><input type="checkbox" name="id" value={i.id} aria-label={`Select ${i.keyword}`} /></td>
                      <td>{i.keyword}</td>
                      <td>{i.title ?? ""}</td>
                      <td>{i.silo_id ? siloName.get(i.silo_id) ?? "" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </form>
        )}
        {canceled.length > 0 ? <p className="pm-muted" style={{ marginTop: "1rem" }}>{canceled.length} cancelled batch{canceled.length === 1 ? "" : "es"}: {canceled.map((b) => b.name).join(", ")}</p> : null}
      </details>
    </AppFrame>
  );
}
