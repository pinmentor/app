import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { clampBatchSize, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE, MIN_BATCH_SIZE } from "@/modules/topical-map/batching";
import { AppFrame } from "../../chrome";
import { MapTabs } from "../../map-tabs";
import { loadMap, suggestFor } from "../load";
import { changeBatch, createAutoBatches, createManualBatch } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Batches — PinMentor" };

const FLASH: Record<string, { text: string; bad: boolean }> = {
  locked: { text: "Not changed: the map is not finished, an article is no longer approved or already in a batch, or the batch has started. Refresh and try again.", bad: true },
  gone: { text: "Not changed: an article or batch was not found (the page may be out of date). Refresh and try again.", bad: true },
  forbidden: { text: "You cannot change this map.", bad: true },
  pick: { text: "Not changed: give the batch a name and pick between 1 and 100 articles.", bad: true },
  nothing: { text: "No approved article is waiting for a batch. Approve articles on the Review tab first.", bad: true },
  error: { text: "Something went wrong. Nothing was changed; please try again.", bad: true },
};
const PILL: Record<string, string> = { planned: "pm-pill-running", running: "pm-pill-running", completed: "pm-pill-succeeded", canceled: "pm-pill-canceled" };

function flashOf(code: string | undefined): { text: string; bad: boolean } | undefined {
  if (!code) return undefined;
  if (FLASH[code]) return FLASH[code];
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
  const firstOfSilo = new Set<string>();

  return (
    <AppFrame email={user.email ?? ""}>
      <p>
        <Link href="/maps">&larr; All maps</Link>
      </p>
      <h1>{map.run.topic}</h1>
      <MapTabs id={map.run.id} current="batches" />
      {flash ? <p className={flash.bad ? "pm-note pm-note-bad" : "pm-note"}>{flash.text}</p> : null}
      {!finished ? <p className="pm-note pm-note-warn">This map is not finished yet, so batches cannot be made.</p> : null}
      <p className="pm-muted">
        A batch is a group of approved articles that will be written together. Making a batch spends no credits and writes nothing yet; it only sets the articles aside. You can cancel it until writing starts.
      </p>

      <section className="pm-section">
        <h2>Suggested batches</h2>
        <form method="get" className="pm-inline" style={{ gap: "0.5rem" }}>
          <label>
            Articles per batch{" "}
            <input className="pm-input pm-input-sm" type="number" name="size" min={MIN_BATCH_SIZE} max={MAX_BATCH_SIZE} defaultValue={size} style={{ width: "5rem" }} />
          </label>
          <button type="submit" className="pm-btn pm-btn-ghost pm-btn-sm">Update</button>
          <span className="pm-muted">
            {MIN_BATCH_SIZE}–{MAX_BATCH_SIZE}; the default is {DEFAULT_BATCH_SIZE}. The main article of a group comes first, then the higher priority.
          </span>
        </form>
        {suggestions.length === 0 ? (
          <p className="pm-muted" style={{ marginTop: "0.75rem" }}>
            Nothing to suggest: no approved article is waiting. <Link href={`/maps/${map.run.id}`}>Approve articles on the Review tab</Link>.
          </p>
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
                        <td>
                          {b.hasPillar ? <strong>{first?.keyword}</strong> : first?.keyword}
                          {b.hasPillar ? <span className="pm-muted"> (main article)</span> : null}
                        </td>
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
              <button type="submit" name="intent" value="all" className="pm-btn pm-btn-brand" disabled={!finished}>
                Create all {suggestions.length} suggested batch{suggestions.length === 1 ? "" : "es"}
              </button>
            </form>
          </>
        )}
      </section>

      <section className="pm-section">
        <h2>Your own batch</h2>
        {free.length === 0 ? (
          <p className="pm-muted">No approved article is free. Cancel a batch or approve more articles first.</p>
        ) : (
          <form action={createManualBatch}>
            <input type="hidden" name="run" value={map.run.id} />
            <div className="pm-inline" style={{ gap: "0.5rem", marginBottom: "0.5rem" }}>
              <label>
                Name{" "}
                <input className="pm-input pm-input-sm" name="name" maxLength={120} required placeholder="e.g. Summer ideas" />
              </label>
              <button type="submit" className="pm-btn pm-btn-ghost pm-btn-sm" disabled={!finished}>Create batch from selected</button>
              <span className="pm-muted">Pick 1–100 articles; they may come from different groups.</span>
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
      </section>

      <section className="pm-section">
        <h2>Batches</h2>
        {open.length === 0 ? <p className="pm-muted">No batch yet.</p> : null}
        {open.map((b) => {
          const mine = map.items.filter((i) => i.batch_id === b.id);
          const planned = b.status === "planned";
          return (
            <form key={b.id} action={changeBatch} style={{ marginTop: "1rem" }}>
              <input type="hidden" name="run" value={map.run.id} />
              <input type="hidden" name="batch" value={b.id} />
              <h3>
                {b.name} <span className={`pm-pill ${PILL[b.status] ?? ""}`}>{b.status}</span>{" "}
                <span className="pm-muted">
                  {mine.length} article{mine.length === 1 ? "" : "s"} · {b.origin === "auto" ? "suggested" : "your own"}
                  {b.silo_id ? ` · ${siloName.get(b.silo_id) ?? ""}` : " · mixed groups"}
                </span>
              </h3>
              <div className="pm-tablewrap">
                <table className="pm-table">
                  <tbody>
                    {mine.map((i) => (
                      <tr key={i.id}>
                        <td>{planned ? <input type="checkbox" name="id" value={i.id} aria-label={`Select ${i.keyword}`} /> : null}</td>
                        <td>{i.keyword}</td>
                        <td>{i.title ?? ""}</td>
                        <td><span className="pm-pill pm-pill-running">{i.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {planned ? (
                <div className="pm-inline" style={{ gap: "0.5rem", marginTop: "0.5rem" }}>
                  <button type="submit" name="intent" value="remove" className="pm-btn pm-btn-ghost pm-btn-sm">Take selected out</button>
                  <button type="submit" name="intent" value="cancel" className="pm-btn pm-btn-quiet pm-btn-sm">Cancel this batch</button>
                  <span className="pm-muted">Articles taken out are approved again.</span>
                </div>
              ) : null}
            </form>
          );
        })}
        {canceled.length > 0 ? (
          <details style={{ marginTop: "1rem" }}>
            <summary className="pm-muted">{canceled.length} cancelled batch{canceled.length === 1 ? "" : "es"}</summary>
            <ul>
              {canceled.map((b) => (
                <li key={b.id}>{b.name}</li>
              ))}
            </ul>
          </details>
        ) : null}
        <p className="pm-muted">Credit estimate per batch: not priced yet (writing articles is not available yet).</p>
      </section>
    </AppFrame>
  );
}
