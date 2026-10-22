import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_BATCH_SIZE, nextBatchBySilo } from "@/modules/topical-map/batching";
import { counters, siloProgress } from "@/modules/topical-map/dashboard";
import { ITEM_STATUSES } from "@/modules/topical-map/review-view";
import { AppFrame } from "../../chrome";
import { MapTabs } from "../../map-tabs";
import { NextStepCard } from "../../next-step-card";
import { loadMap, nextInputOf, suggestFor } from "../load";

export const dynamic = "force-dynamic";
export const metadata = { title: "Map dashboard — PinMentor" };

const LABEL: Record<string, string> = {
  proposed: "to review", approved: "approved", in_batch: "in a batch", writing: "being written", draft_ready: "draft ready", in_review: "in review",
  scheduled: "scheduled", published: "published", pins_pending: "pins pending", done: "done", rejected: "rejected", already_exists: "already exists",
};

export default async function MapDashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const id = z.string().uuid().safeParse((await params).id);
  if (!id.success) notFound();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/maps/${id.data}/dashboard`)}`);

  const map = await loadMap(supabase, id.data);
  if (!map) notFound();
  const all = counters(map.items.map((i) => i.status));
  const next = nextBatchBySilo(suggestFor(map, DEFAULT_BATCH_SIZE));
  const approvedFree = map.items.filter((i) => i.status === "approved" && !i.batch_id).length;
  const openBatches = map.batches.filter((b) => b.status === "planned" || b.status === "running").length;
  const tiles: { label: string; n: number; hint: string }[] = [
    { label: "Total", n: all.total, hint: "every article of the map" },
    { label: "Remaining", n: all.remaining, hint: "to review, approved, in a batch" },
    { label: "In progress", n: all.inProgress, hint: "being written or reviewed" },
    { label: "Completed", n: all.completed, hint: "scheduled or published" },
    { label: "Set aside", n: all.setAside, hint: "rejected or already existing" },
  ];

  return (
    <AppFrame email={user.email ?? ""}>
      <p>
        <Link href="/maps">&larr; All maps</Link>
      </p>
      <h1>{map.run.topic}</h1>
      <MapTabs id={map.run.id} current="dashboard" />
      <NextStepCard runId={map.run.id} input={nextInputOf(map)} />

      <div className="pm-counters">
        {tiles.map((t) => (
          <div key={t.label} className="pm-counter">
            <b>{t.n}</b>
            <span>{t.label}</span>
            <small>{t.hint}</small>
          </div>
        ))}
      </div>

      <p className="pm-muted">
        Credits to finish the map: <strong>not priced yet</strong>. Writing articles is not available yet, so no estimate is shown rather than a guessed one.
      </p>

      <div className="pm-inline" style={{ gap: "0.75rem", margin: "1rem 0" }}>
        <Link href={`/maps/${map.run.id}/batches`} className="pm-btn pm-btn-brand">
          {approvedFree > 0 ? "Start the next batch" : "Open batches"}
        </Link>
        <span className="pm-muted">
          {approvedFree > 0 ? `${approvedFree} approved article${approvedFree === 1 ? "" : "s"} waiting for a batch` : "No approved article is waiting for a batch."}
          {openBatches > 0 ? ` ${openBatches} open batch${openBatches === 1 ? "" : "es"}.` : ""}
        </span>
      </div>
      {all.remaining > 0 && approvedFree === 0 && all.total > 0 ? (
        <p className="pm-note pm-note-warn">
          Nothing to batch yet. <Link href={`/maps/${map.run.id}`}>Review the map</Link> and approve the articles you want first.
        </p>
      ) : null}

      <section className="pm-section">
        <h2>Groups</h2>
        <div className="pm-silocards">
          {map.silos.map((s) => {
            const mine = map.items.filter((i) => i.silo_id === s.id);
            const p = siloProgress(mine.map((i) => i.status));
            const by = ITEM_STATUSES.map((st) => [st, mine.filter((i) => i.status === st).length] as const).filter(([, n]) => n > 0);
            const nb = next.get(s.id);
            return (
              <article key={s.id} className="pm-sc">
                <div className="pm-sc-head">
                  <div className="pm-ring" style={{ ["--p" as string]: `${p.pct}%` }} role="img" aria-label={`${p.done} of ${p.of} complete`}>
                    <span>{p.pct}%</span>
                  </div>
                  <div>
                    <h3>{s.name}</h3>
                    <p className="pm-muted">
                      {p.done}/{p.of} complete · {mine.length} article{mine.length === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>
                <p className="pm-muted pm-sc-by">{by.length ? by.map(([st, n]) => `${n} ${LABEL[st]}`).join(" · ") : "empty"}</p>
                <p className="pm-sc-next">
                  {nb ? (
                    <>
                      Next batch: <strong>{nb.itemIds.length}</strong> article{nb.itemIds.length === 1 ? "" : "s"}
                      {nb.hasPillar ? ", main article first" : ""}
                      {nb.pillarPending ? " (its main article is not approved yet)" : ""}
                    </>
                  ) : (
                    <span className="pm-muted">No approved article waiting.</span>
                  )}
                </p>
              </article>
            );
          })}
          {map.silos.length === 0 ? <p className="pm-muted">This map has no groups.</p> : null}
        </div>
        <p className="pm-muted">Progress counts articles that are scheduled or published, out of all articles that are not rejected. Batch sizes here use the default of {DEFAULT_BATCH_SIZE}.</p>
      </section>
    </AppFrame>
  );
}
