import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { AppFrame } from "./chrome";

export const dynamic = "force-dynamic";
export const metadata = { title: "Topical maps — PinMentor" };

const runRows = z.array(
  z.object({ id: z.string().uuid(), topic: z.string(), locale: z.string(), status: z.string(), stage: z.string(), created_at: z.string(), params: z.record(z.string(), z.unknown()), target_max: z.number() }),
);

export default async function MapsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=%2Fmaps");

  // RLS: only the runs of the user's own workspace(s)
  const res = await supabase.from("map_runs").select("id, topic, locale, status, stage, created_at, params, target_max").order("created_at", { ascending: false }).limit(50);
  const runs = runRows.safeParse(res.data ?? []);

  return (
    <AppFrame email={user.email ?? ""}>
      <h1>Topical maps</h1>
      {res.error || !runs.success ? <p className="pm-note pm-note-bad">Could not load your maps. Please refresh.</p> : null}
      {runs.success && runs.data.length === 0 ? (
        <div className="pm-empty">
          <h2>No maps yet</h2>
          <p>Maps are started from the admin area for now. When one is finished it appears here for review.</p>
        </div>
      ) : null}
      {runs.success && runs.data.length > 0 ? (
        <div className="pm-tablewrap">
          <table className="pm-table">
            <thead>
              <tr><th>Topic</th><th>Language</th><th>Size</th><th>Status</th><th>Started</th></tr>
            </thead>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id}>
                  <td>{r.status === "succeeded" ? <Link href={`/maps/${r.id}`}>{r.topic}</Link> : r.topic}</td>
                  <td>{r.locale}</td>
                  <td>{r.params.size === "auto" ? `auto (ceiling ${r.target_max})` : `up to ${r.target_max}`}</td>
                  <td>{r.status === "succeeded" ? "ready for review" : `${r.status} (${r.stage})`}</td>
                  <td className="pm-nowrap">{r.created_at.slice(0, 16).replace("T", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </AppFrame>
  );
}
