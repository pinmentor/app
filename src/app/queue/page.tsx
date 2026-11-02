import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { AppFrame } from "@/app/maps/chrome";

export const dynamic = "force-dynamic";
export const metadata = { title: "Queue — PinMentor" };

const articleRows = z.array(z.object({ id: z.string().uuid(), map_run_id: z.string().uuid(), batch_id: z.string().uuid(), keyword: z.string(), title: z.string().nullable(), status: z.string(), last_error: z.string().nullable(), updated_at: z.string() }));
const mapRows = z.array(z.object({ id: z.string().uuid(), topic: z.string(), status: z.string(), stage: z.string(), created_at: z.string() }));

const STAGE_TEXT: Record<string, string> = { queued: "waiting to start" };

/**
 * What the system is working on for the user, in the user's words. It is built from the articles and maps themselves (which the user
 * may read through RLS); the raw job table stays admin-only. Failed items link to where they can be written again.
 */
export default async function QueuePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=%2Fqueue");

  const [arts, maps] = await Promise.all([
    supabase.from("articles").select("id, map_run_id, batch_id, keyword, title, status, last_error, updated_at").in("status", ["queued", "writing", "failed"]).order("updated_at", { ascending: false }).limit(100),
    supabase.from("map_runs").select("id, topic, status, stage, created_at").not("status", "in", "(succeeded,canceled)").order("created_at", { ascending: false }).limit(20),
  ]);
  const a = articleRows.safeParse(arts.data ?? []);
  const m = mapRows.safeParse(maps.data ?? []);
  const loadFailed = Boolean(arts.error || maps.error) || !a.success || !m.success;
  const articles = a.success ? a.data : [];
  const runs = m.success ? m.data : [];
  const working = articles.filter((x) => x.status === "writing");
  const waiting = articles.filter((x) => x.status === "queued");
  const failed = articles.filter((x) => x.status === "failed");
  const buildingMaps = runs.filter((r) => r.status !== "failed");
  const recent = Date.now() - 14 * 24 * 3600 * 1000; // an old failed map is history, not something to act on
  const failedMaps = runs.filter((r) => r.status === "failed" && Date.parse(r.created_at) > recent);
  const empty = !loadFailed && articles.length === 0 && runs.length === 0;

  return (
    <AppFrame email={user.email ?? ""}>
      <div className="pm-pagehead">
        <div>
          <h1>Queue</h1>
          <p>What is being written or built right now, what is waiting, and what needs your attention. Refresh the page to see progress.</p>
        </div>
      </div>

      {loadFailed ? <p className="pm-note pm-note-bad">Could not load the queue. Please refresh the page.</p> : null}
      {empty ? (
        <div className="pm-empty">
          <h2>Nothing in the queue</h2>
          <p>Nothing is being written or built. When you write a batch, its articles show up here until they are ready.</p>
          <Link href="/maps" className="pm-btn pm-btn-primary">Open your maps</Link>
        </div>
      ) : null}

      {failed.length + failedMaps.length > 0 ? (
        <section className="pm-section">
          <h2>Needs your attention ({failed.length + failedMaps.length})</h2>
          <ul className="pm-list">
            {failedMaps.map((r) => (
              <li key={r.id}><b>Map “{r.topic}”</b> did not finish. Start it again, or contact support if it keeps failing.</li>
            ))}
            {failed.map((x) => (
              <li key={x.id}>
                <Link href={`/maps/${x.map_run_id}/articles/${x.id}`}>{x.title ?? x.keyword}</Link> could not be written{x.last_error ? `: ${x.last_error}` : ""}.{" "}
                <Link href={`/maps/${x.map_run_id}/batches`}>Open the batch to write it again</Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {working.length + buildingMaps.length > 0 ? (
        <section className="pm-section">
          <h2>In progress ({working.length + buildingMaps.length})</h2>
          <ul className="pm-list">
            {buildingMaps.map((r) => (
              <li key={r.id}>Map “{r.topic}” is being built — {STAGE_TEXT[r.stage] ?? r.stage}</li>
            ))}
            {working.map((x) => (
              <li key={x.id}><Link href={`/maps/${x.map_run_id}/batches`}>{x.title ?? x.keyword}</Link> is being written</li>
            ))}
          </ul>
        </section>
      ) : null}

      {waiting.length > 0 ? (
        <section className="pm-section">
          <h2>Waiting ({waiting.length})</h2>
          <ul className="pm-list">
            {waiting.map((x) => (
              <li key={x.id}><Link href={`/maps/${x.map_run_id}/batches`}>{x.title ?? x.keyword}</Link> is waiting for its turn</li>
            ))}
          </ul>
        </section>
      ) : null}
    </AppFrame>
  );
}
