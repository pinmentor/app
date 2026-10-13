import { redirect } from "next/navigation";
import { z } from "zod";
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
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-4 py-16">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-neutral-600">{user.email}</p>
        </div>
        <form action={signOut}>
          <button type="submit" className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm">
            Sign out
          </button>
        </form>
      </header>

      {loadFailed ? <p className="text-sm text-red-600">Could not load your workspace. Please refresh.</p> : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Workspaces</h2>
        {rows.length === 0 && !loadFailed ? <p className="text-sm text-neutral-600">No workspace yet.</p> : null}
        {rows.map((w) => (
          <div key={w.id} className="rounded-lg border border-neutral-200 p-4">
            <div className="flex items-baseline justify-between">
              <span className="font-medium">{w.name}</span>
              <span className="text-xs uppercase tracking-wide text-neutral-500">{w.role}</span>
            </div>
            <p className="mt-2 text-sm text-neutral-700">
              {w.trialCredits === null
                ? "Trial credits are granted once your email is confirmed."
                : `Trial credits: ${w.trialCredits}`}
            </p>
          </div>
        ))}
      </section>
    </main>
  );
}
