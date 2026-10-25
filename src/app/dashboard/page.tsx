import { redirect } from "next/navigation";
import { z } from "zod";
import Link from "next/link";
import { Coin, Logo } from "@/components/brand";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard — PinMentor" };

const membershipRows = z.array(z.object({ workspace_id: z.uuid(), role: z.string() }));
const workspaceRows = z.array(z.object({ id: z.uuid(), name: z.string() }));
const trialRows = z.array(z.object({ workspace_id: z.uuid(), granted_credits: z.number().int() }));

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=%2Fdashboard");

  // All three reads go through RLS: the user only ever sees their own workspace(s).
  const [membersRes, workspacesRes, trialsRes] = await Promise.all([
    supabase.from("workspace_members").select("workspace_id, role").eq("user_id", user.id),
    supabase.from("workspaces").select("id, name"),
    supabase.from("trials").select("workspace_id, granted_credits"),
  ]);

  const members = membershipRows.safeParse(membersRes.data ?? []);
  const workspaces = workspaceRows.safeParse(workspacesRes.data ?? []);
  const trials = trialRows.safeParse(trialsRes.data ?? []);
  const loadFailed =
    Boolean(membersRes.error || workspacesRes.error || trialsRes.error) ||
    !members.success ||
    !workspaces.success ||
    !trials.success;

  const rows =
    members.success && workspaces.success && trials.success
      ? members.data.flatMap((m) => {
          const ws = workspaces.data.find((w) => w.id === m.workspace_id);
          if (!ws) return [];
          const trial = trials.data.find((t) => t.workspace_id === ws.id);
          return [{ id: ws.id, name: ws.name, role: m.role, trialCredits: trial?.granted_credits ?? null }];
        })
      : [];

  return (
    <>
      <header className="pm-appbar">
        <div className="pm-wrap pm-appbar-in">
          <Logo href="/dashboard" />
          <div className="pm-appbar-user">
            <span>{user.email}</span>
            <form action={signOut}>
              <button type="submit" className="pm-btn pm-btn-quiet pm-btn-sm">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="pm-wrap pm-page">
        <h1>Dashboard</h1>

        {loadFailed ? <p className="pm-note pm-note-bad">Could not load your workspace. Please refresh.</p> : null}

        {rows.length === 0 && !loadFailed ? (
          <div className="pm-empty">
            <h2>No workspace yet</h2>
            <p>Your workspace is created when you confirm your email. Refresh this page after confirming.</p>
          </div>
        ) : null}

        {rows.map((w) => (
          <section key={w.id} className="pm-ws">
            <div>
              <h2>{w.name}</h2>
              <div className="pm-ws-meta">
                <span className="pm-pill pm-pill-role">{w.role}</span>
                {w.trialCredits === null ? <span>Trial credits are granted once your email is confirmed.</span> : null}
                <Link href="/maps">Topical maps &rarr;</Link>
                <Link href="/sites">WordPress &rarr;</Link>
              </div>
            </div>
            {w.trialCredits !== null ? (
              <div className="pm-credit">
                <Coin />
                <div>
                  <div className="pm-credit-n">{w.trialCredits}</div>
                  <div className="pm-credit-label">Trial credits</div>
                </div>
              </div>
            ) : null}
          </section>
        ))}
      </main>
    </>
  );
}
