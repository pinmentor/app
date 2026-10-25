import Link from "next/link";
import { z } from "zod";
import { PathList } from "@/components/path";
import { requireAdmin } from "@/lib/admin/guard";
import { taskCostRowSchema, usd } from "@/lib/admin/credit-rates";
import { adminAttention, adminSetup, type AdminInput } from "@/lib/home/admin-overview";
import { masterKeyStatus } from "@/lib/secrets/crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { AdminShell } from "./admin-nav";

export const dynamic = "force-dynamic";
export const metadata = { title: "Overview — PinMentor Admin" };

const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

export default async function AdminHome() {
  const { role } = await requireAdmin();
  const sb = createAdminClient();
  const head = { count: "exact" as const, head: true };

  const [keys, rate, dead, failedArt, queued, maps, mapsRunning, users, ready7, wp7, cost, sites] = await Promise.all([
    sb.from("platform_secrets").select("provider", head),
    sb.from("credit_rates").select("credits").eq("action", "article_write").maybeSingle(),
    sb.from("jobs").select("id", head).eq("state", "dead").gte("finished_at", ago(7 * DAY)),
    sb.from("articles").select("id", head).eq("status", "failed").gte("created_at", ago(7 * DAY)),
    sb.from("jobs").select("id", head).eq("state", "queued").lte("run_at", ago(10 * 60_000)),
    sb.from("map_runs").select("id", head),
    sb.from("map_runs").select("id", head).in("status", ["queued", "running"]),
    sb.from("profiles").select("user_id", head),
    sb.from("articles").select("id", head).eq("status", "ready").gte("created_at", ago(7 * DAY)),
    sb.from("articles").select("id", head).not("wp_post_id", "is", null).gte("wp_pushed_at", ago(7 * DAY)),
    sb.rpc("admin_llm_cost_by_task", { p_days: 7 }),
    sb.from("sites").select("id", head),
  ]);

  const credits = z.object({ credits: z.number() }).safeParse(rate.data);
  const input: AdminInput = {
    encryptionKey: masterKeyStatus(),
    keysSet: keys.count ?? 0,
    articleWriteRate: credits.success ? credits.data.credits : null,
    deadJobs7d: dead.count ?? 0,
    failedArticles7d: failedArt.count ?? 0,
    stuckQueued: queued.count ?? 0,
    mapsTotal: maps.count ?? 0,
  };
  const attention = adminAttention(input);
  const setup = adminSetup(input);
  const costRows = z.array(taskCostRowSchema).safeParse(cost.data ?? []);
  const cost7 = costRows.success ? costRows.data.reduce((t, r) => t + (r.total_cost_usd ?? 0), 0) : null;
  const loadFailed = [keys, rate, dead, failedArt, queued, maps, mapsRunning, users, ready7, wp7, cost, sites].some((r) => Boolean(r.error));

  return (
    <AdminShell current="overview" role={role}>
      <div className="pm-pagehead">
        <div>
          <h1>Overview</h1>
          <p>What needs you right now, and how the platform did in the last 7 days.</p>
        </div>
      </div>

      {loadFailed ? <p className="pm-note pm-note-bad">Some numbers could not be loaded (a migration may be missing). The rest is shown.</p> : null}

      {attention.length > 0 ? (
        <>
          <h2 className="pm-home-h">Needs attention</h2>
          <ul className="pm-attn">
            {attention.map((a) => (
              <li key={a.id} className={a.tone === "bad" ? "pm-attn-bad" : "pm-attn-warn"}>
                <span>{a.text}</span>
                <Link href={a.href} className="pm-btn pm-btn-sm">{a.cta}</Link>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="pm-note pm-note-ok">All clear: keys, price and queue look healthy.</p>
      )}

      {setup.now !== -1 ? (
        <>
          <h2 className="pm-home-h">Set up the platform</h2>
          <PathList steps={setup.steps} now={setup.now} />
        </>
      ) : null}

      <h2 className="pm-home-h">Last 7 days</h2>
      <div className="pm-stats">
        <div className="pm-stat"><b>{users.count ?? "—"}</b><span>users in total</span></div>
        <div className="pm-stat"><b>{ready7.count ?? "—"}</b><span>articles written</span></div>
        <div className="pm-stat"><b>{wp7.count ?? "—"}</b><span>drafts sent to WordPress</span></div>
        <div className="pm-stat"><b>{usd(cost7)}</b><span>AI cost</span></div>
        <div className="pm-stat"><b>{mapsRunning.count ?? "—"}</b><span>maps being built</span></div>
        <div className="pm-stat"><b>{sites.count ?? "—"}</b><span>WordPress sites</span></div>
      </div>
      <p className="pm-muted">
        Details: <Link href="/admin/users">users</Link> · <Link href="/admin/jobs">jobs and AI calls</Link> · <Link href="/admin/credits">what an article really costs</Link>
      </p>
    </AdminShell>
  );
}
