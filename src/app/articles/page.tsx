import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { AppFrame } from "@/app/maps/chrome";

export const dynamic = "force-dynamic";
export const metadata = { title: "Articles — PinMentor" };

const rows = z.array(
  z.object({
    id: z.string().uuid(),
    map_run_id: z.string().uuid(),
    keyword: z.string(),
    title: z.string().nullable(),
    status: z.string(),
    qa: z.record(z.string(), z.unknown()).nullable(),
    wp_post_id: z.union([z.number(), z.string()]).nullable(),
    wp_status: z.string().nullable(),
    word_count: z.number().nullable(),
    updated_at: z.string(),
  }),
);

const STATUS = ["all", "ready", "writing", "queued", "failed"] as const;
const LIGHT = ["all", "pass", "flag", "fail"] as const;
const WP = ["all", "sent", "unsent"] as const;
const pick = <T extends readonly string[]>(list: T, v: string | string[] | undefined): T[number] => (typeof v === "string" && (list as readonly string[]).includes(v) ? v : "all");

const LIGHT_LABEL: Record<string, { text: string; cls: string }> = {
  pass: { text: "checks passed", cls: "pm-pill-succeeded" },
  flag: { text: "needs a look", cls: "pm-pill-running" },
  fail: { text: "blocked", cls: "pm-pill-dead" },
};
const WP_LABEL: Record<string, string> = { draft: "draft in WordPress", publish: "published", future: "scheduled" };

function Chips({ label, name, options, current, params }: { label: string; name: string; options: readonly string[]; current: string; params: Record<string, string> }) {
  return (
    <div className="pm-chips" role="group" aria-label={label}>
      <span className="pm-muted">{label}:</span>
      {options.map((o) => {
        const q = new URLSearchParams({ ...params, [name]: o });
        for (const [k, v] of [...q.entries()]) if (v === "all") q.delete(k);
        const qs = q.toString();
        return (
          <Link key={o} href={qs ? `/articles?${qs}` : "/articles"} aria-current={o === current ? "true" : undefined}>
            {o === "all" ? "All" : o}
          </Link>
        );
      })}
    </div>
  );
}

export default async function ArticlesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=%2Farticles");
  const raw = await searchParams;
  const status = pick(STATUS, raw.status);
  const light = pick(LIGHT, raw.light);
  const wp = pick(WP, raw.wp);

  // RLS limits this to the user's own workspace(s)
  let q = supabase.from("articles").select("id, map_run_id, keyword, title, status, qa, wp_post_id, wp_status, word_count, updated_at").order("updated_at", { ascending: false }).limit(200);
  if (status !== "all") q = q.eq("status", status);
  if (light !== "all") q = q.eq("qa->>verdict", light);
  if (wp === "sent") q = q.not("wp_post_id", "is", null);
  if (wp === "unsent") q = q.is("wp_post_id", null);
  const res = await q;
  const parsed = rows.safeParse(res.data ?? []);
  const list = parsed.success ? parsed.data : [];
  const params = { status, light, wp };
  const filtered = status !== "all" || light !== "all" || wp !== "all";

  return (
    <AppFrame email={user.email ?? ""}>
      <div className="pm-pagehead">
        <div>
          <h1>Articles</h1>
          <p>Every article from all your maps in one place. Open one to read it, check it and send it to WordPress.</p>
        </div>
      </div>

      <details className="pm-more" open={filtered}>
        <summary>Filter</summary>
        <Chips label="Status" name="status" options={STATUS} current={status} params={params} />
        <Chips label="Checks" name="light" options={LIGHT} current={light} params={params} />
        <Chips label="WordPress" name="wp" options={WP} current={wp} params={params} />
      </details>

      {res.error || !parsed.success ? <p className="pm-note pm-note-bad">Could not load your articles. Please refresh the page.</p> : null}

      {!res.error && parsed.success && list.length === 0 ? (
        <div className="pm-empty">
          <h2>{filtered ? "No article matches this filter" : "No articles yet"}</h2>
          <p>{filtered ? "Clear a filter above to see more." : "Approve ideas in a map, group them into a batch and write it. Finished articles appear here."}</p>
          <Link href={filtered ? "/articles" : "/maps"} className="pm-btn pm-btn-primary">{filtered ? "Show all articles" : "Open your maps"}</Link>
        </div>
      ) : null}

      {list.length > 0 ? (
        <div className="pm-tablewrap">
          <table className="pm-table">
            <thead>
              <tr><th>Article</th><th>Status</th><th>Checks</th><th>WordPress</th><th>Words</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {list.map((a) => {
                const verdict = typeof a.qa?.verdict === "string" ? a.qa.verdict : undefined;
                const l = a.status === "ready" && verdict ? LIGHT_LABEL[verdict] : undefined;
                return (
                  <tr key={a.id}>
                    <td><Link href={`/maps/${a.map_run_id}/articles/${a.id}`}>{a.title ?? a.keyword}</Link></td>
                    <td>{a.status}</td>
                    <td>{l ? <span className={`pm-pill ${l.cls}`}>{l.text}</span> : "—"}</td>
                    <td>{a.wp_post_id === null ? "not sent" : (WP_LABEL[a.wp_status ?? ""] ?? "sent")}</td>
                    <td>{a.word_count ?? "—"}</td>
                    <td className="pm-nowrap">{a.updated_at.slice(0, 16).replace("T", " ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {list.length === 200 ? <p className="pm-muted">Showing the 200 most recent. Use the filters to narrow down.</p> : null}
    </AppFrame>
  );
}
