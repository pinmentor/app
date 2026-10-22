import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { AppFrame } from "../../../chrome";

export const dynamic = "force-dynamic";
export const metadata = { title: "Article — PinMentor" };

const rowSchema = z.object({
  id: z.string().uuid(), map_run_id: z.string().uuid(), status: z.string(), title: z.string().nullable(), slug: z.string().nullable(), keyword: z.string(),
  body_html: z.string().nullable(), word_count: z.number().nullable(), last_error: z.string().nullable(),
  qa: z.object({ verdict: z.string().optional(), checks: z.array(z.object({ id: z.string(), status: z.string(), summary: z.string() })).optional() }).passthrough(),
});

/** Own stylesheet for the preview: the article HTML is generated and escaped by our code, and shown in a sandbox with no scripts. */
const PREVIEW_CSS =
  "body{font:16px/1.65 system-ui,sans-serif;max-width:46rem;margin:1.5rem auto;padding:0 1rem;color:#1c2321}h1{font-size:1.8rem;line-height:1.25}h2{font-size:1.3rem;margin-top:2rem}h3{font-size:1.05rem}ul{padding-left:1.25rem}";

const QA_TONE: Record<string, string> = { pass: "pm-pill-succeeded", flag: "pm-pill-running", fail: "pm-pill-dead" };

export default async function ArticlePage({ params }: { params: Promise<{ id: string; articleId: string }> }) {
  const p = await params;
  const ids = z.object({ id: z.string().uuid(), articleId: z.string().uuid() }).safeParse(p);
  if (!ids.success) notFound();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/maps/${ids.data.id}/articles/${ids.data.articleId}`)}`);

  // through the user's session: another workspace's article is simply not found (RLS)
  const res = await supabase
    .from("articles")
    .select("id, map_run_id, status, title, slug, keyword, body_html, word_count, last_error, qa")
    .eq("id", ids.data.articleId)
    .eq("map_run_id", ids.data.id)
    .maybeSingle();
  const a = rowSchema.safeParse(res.data);
  if (!a.success) notFound();
  const art = a.data;
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><style>${PREVIEW_CSS}</style></head><body>${art.body_html ?? ""}</body></html>`;

  return (
    <AppFrame email={user.email ?? ""}>
      <p>
        <Link href={`/maps/${art.map_run_id}/batches`}>&larr; Back to batches</Link>
      </p>
      <h1>{art.title ?? art.keyword}</h1>
      <p className="pm-muted">
        {art.keyword} · {art.status}
        {art.word_count !== null ? ` · ${art.word_count} words` : ""}
        {art.slug ? ` · /${art.slug}` : ""}
      </p>
      {art.status === "failed" || art.status === "canceled" ? <p className="pm-note pm-note-bad">This article was not written ({art.last_error ?? art.status}). It was not charged.</p> : null}
      {art.status === "queued" || art.status === "writing" ? <p className="pm-note">Still being written. Refresh in a minute.</p> : null}

      {art.qa.checks && art.qa.checks.length > 0 ? (
        <section className="pm-section">
          <h2>
            Automatic checks <span className={`pm-pill ${QA_TONE[art.qa.verdict ?? ""] ?? ""}`}>{art.qa.verdict ?? "?"}</span>
          </h2>
          <p className="pm-muted">
            Mechanical checks only (item count, length, price and year wording, stock phrases, invented experience, English leaks). No second-model language review, fact check or image check is done yet, so read it before you use it.
          </p>
          <div className="pm-tablewrap">
            <table className="pm-table">
              <tbody>
                {art.qa.checks.map((c) => (
                  <tr key={c.id}>
                    <td>{c.id}</td>
                    <td><span className={`pm-pill ${QA_TONE[c.status] ?? ""}`}>{c.status}</span></td>
                    <td>{c.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {art.body_html ? (
        <section className="pm-section">
          <h2>Preview</h2>
          <iframe title="Article preview" sandbox="" srcDoc={srcDoc} style={{ width: "100%", height: "70vh", border: "1px solid var(--line, #d8dedb)", borderRadius: "0.5rem", background: "#fff" }} />
        </section>
      ) : null}
    </AppFrame>
  );
}
