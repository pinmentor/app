import { redirect } from "next/navigation";
import { z } from "zod";
import Link from "next/link";
import { Logo } from "@/components/brand";
import { PathList } from "@/components/path";
import { userPath } from "@/lib/home/user-path";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard — PinMentor" };

const workspaceRows = z.array(z.object({ id: z.string().uuid(), name: z.string() }));
const mapRows = z.array(z.object({ id: z.string().uuid(), status: z.string() }));
const articleRows = z.array(z.object({ id: z.string().uuid(), map_run_id: z.string().uuid(), wp_post_id: z.union([z.number(), z.string()]).nullable() }));
const balanceRows = z.array(z.object({ available: z.number(), held: z.number() }));
const APPROVED_OR_LATER = ["approved", "in_batch", "writing", "draft_ready", "in_review", "scheduled", "published", "pins_pending", "done"];

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=%2Fdashboard");

  // Every read goes through RLS: the user only ever sees their own workspace(s). Only the credit balance needs the server key.
  const wsRes = await supabase.from("workspaces").select("id, name");
  const workspaces = workspaceRows.safeParse(wsRes.data ?? []);
  const loadFailed = Boolean(wsRes.error) || !workspaces.success;

  const homes = await Promise.all(
    (workspaces.success ? workspaces.data : []).map(async (w) => {
      const [sites, maps, approved, ready, bal] = await Promise.all([
        supabase.from("sites").select("id").eq("workspace_id", w.id).eq("status", "connected"),
        supabase.from("map_runs").select("id, status").eq("workspace_id", w.id).eq("status", "succeeded").order("created_at", { ascending: false }).limit(50),
        supabase.from("plan_items").select("id", { count: "exact", head: true }).eq("workspace_id", w.id).in("status", APPROVED_OR_LATER),
        supabase.from("articles").select("id, map_run_id, wp_post_id").eq("workspace_id", w.id).eq("status", "ready").order("created_at", { ascending: false }).limit(500),
        createAdminClient().rpc("credit_balance", { p_workspace: w.id }),
      ]);
      const m = mapRows.safeParse(maps.data ?? []);
      const a = articleRows.safeParse(ready.data ?? []);
      const b = balanceRows.safeParse(bal.data ?? []);
      const arts = a.success ? a.data : [];
      const unsent = arts.find((x) => x.wp_post_id === null);
      const path = userPath({
        sitesConnected: (sites.data ?? []).length,
        mapsReady: m.success ? m.data.length : 0,
        latestMapId: m.success ? (m.data[0]?.id ?? null) : null,
        itemsApproved: approved.count ?? 0,
        articlesReady: arts.length,
        draftsSent: arts.length - arts.filter((x) => x.wp_post_id === null).length,
        unsent: unsent ? { runId: unsent.map_run_id, articleId: unsent.id } : null,
      });
      return { ws: w, path, credits: b.success ? (b.data[0]?.available ?? 0) : null, maps: m.success ? m.data.length : 0, ready: arts.length, sent: arts.length - arts.filter((x) => x.wp_post_id === null).length, failed: Boolean(sites.error || maps.error || ready.error) };
    }),
  );

  return (
    <>
      <header className="pm-appbar">
        <div className="pm-wrap pm-appbar-in">
          <Logo href="/dashboard" />
          <div className="pm-appbar-user">
            <Link href="/maps">Maps</Link>
            <Link href="/sites">WordPress</Link>
            <span>{user.email}</span>
            <form action={signOut}>
              <button type="submit" className="pm-btn pm-btn-quiet pm-btn-sm">Sign out</button>
            </form>
          </div>
        </div>
      </header>

      <main className="pm-wrap pm-page">
        {loadFailed ? <p className="pm-note pm-note-bad">Could not load your workspace. Please refresh.</p> : null}

        {homes.length === 0 && !loadFailed ? (
          <div className="pm-empty">
            <h1>Welcome</h1>
            <p>Your workspace is created when you confirm your email. Refresh this page after confirming.</p>
          </div>
        ) : null}

        {homes.map((h) => (
          <section key={h.ws.id} aria-label={h.ws.name}>
            <h1>{h.path.now === -1 ? "You are all set up" : "Welcome — here is your path"}</h1>
            <p className="pm-muted" style={{ marginTop: 0 }}>
              {h.path.now === -1 ? "Everything is connected and working. Keep writing, or open your maps." : "Follow the steps in order. Each one has a single button."}
            </p>
            {h.failed ? <p className="pm-note pm-note-bad">Some numbers could not be loaded. Refresh the page.</p> : null}

            <PathList steps={h.path.steps} now={h.path.now} />

            <div className="pm-stats" aria-label="Your numbers">
              <div className="pm-stat"><b>{h.credits ?? "—"}</b><span>credits available</span></div>
              <div className="pm-stat"><b>{h.maps}</b><span>topical maps</span></div>
              <div className="pm-stat"><b>{h.ready}</b><span>articles ready</span></div>
              <div className="pm-stat"><b>{h.sent}</b><span>drafts in WordPress</span></div>
            </div>
            <p className="pm-muted">{h.ws.name}</p>
          </section>
        ))}
      </main>
    </>
  );
}
