import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { GLOSS_LANGS, glossRowCount, isGlossLang, type GlossLang } from "@/modules/articles/gloss";
import { LIGHT_TEXT, lightOf, storedReviewSchema } from "@/modules/articles/review";
import { AppFrame } from "../../../chrome";
import { requestGloss } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Article — PinMentor" };

const rowSchema = z.object({
  id: z.string().uuid(), map_run_id: z.string().uuid(), status: z.string(), title: z.string().nullable(), slug: z.string().nullable(), keyword: z.string(),
  body_html: z.string().nullable(), word_count: z.number().nullable(), last_error: z.string().nullable(),
  qa: z.object({ verdict: z.string().optional(), checks: z.array(z.object({ id: z.string(), status: z.string(), summary: z.string() })).optional() }).passthrough(),
  review: z.unknown(), outline: z.object({ n: z.number() }).passthrough(),
});
const sectionRow = z.object({ kind: z.string(), idx: z.number(), content: z.unknown() });

/** Own stylesheet for the preview: the article HTML is generated and escaped by our code, and shown in a sandbox with no scripts. */
const PREVIEW_CSS =
  "body{font:16px/1.65 system-ui,sans-serif;max-width:46rem;margin:1.5rem auto;padding:0 1rem;color:#1c2321}h1{font-size:1.8rem;line-height:1.25}h2{font-size:1.3rem;margin-top:2rem}h3{font-size:1.05rem}ul{padding-left:1.25rem}";

const TONE: Record<string, string> = { pass: "pm-pill-succeeded", flag: "pm-pill-running", fail: "pm-pill-dead", green: "pm-pill-succeeded", yellow: "pm-pill-running", red: "pm-pill-dead" };
const FLASH: Record<string, { text: string; bad: boolean }> = {
  started: { text: "Translation started. Refresh this page in a minute or two; parts appear as they finish.", bad: false },
  notready: { text: "This article is not finished, so it cannot be translated yet.", bad: true },
  gone: { text: "Article not found.", bad: true },
  error: { text: "Something went wrong. Nothing was changed; try again.", bad: true },
};

type Block = { label: string; original: string[]; translated: string[] | null };
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

export default async function ArticlePage({ params, searchParams }: { params: Promise<{ id: string; articleId: string }>; searchParams: Promise<{ lang?: string; flash?: string }> }) {
  const p = await params;
  const ids = z.object({ id: z.string().uuid(), articleId: z.string().uuid() }).safeParse(p);
  if (!ids.success) notFound();
  const sp = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/maps/${ids.data.id}/articles/${ids.data.articleId}`)}`);

  // through the user's session: another workspace's article is simply not found (RLS)
  const res = await supabase
    .from("articles")
    .select("id, map_run_id, status, title, slug, keyword, body_html, word_count, last_error, qa, review, outline")
    .eq("id", ids.data.articleId)
    .eq("map_run_id", ids.data.id)
    .maybeSingle();
  const a = rowSchema.safeParse(res.data);
  if (!a.success) notFound();
  const art = a.data;
  const ready = art.status === "ready";
  const light = lightOf(art.qa.verdict);
  const review = storedReviewSchema.safeParse(art.review);
  const lang: GlossLang | null = isGlossLang(sp.lang) ? sp.lang : null;
  const flash = sp.flash ? FLASH[sp.flash] : undefined;
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><style>${PREVIEW_CSS}</style></head><body>${art.body_html ?? ""}</body></html>`;

  // translation view: original blocks next to their translation
  let blocks: Block[] = [];
  let glossRows = 0;
  if (ready && lang) {
    const [secRes, glRes] = await Promise.all([
      supabase.from("article_sections").select("kind, idx, content").eq("article_id", art.id).order("idx"),
      supabase.from("article_gloss").select("kind, idx, content").eq("article_id", art.id).eq("lang", lang).order("idx"),
    ]);
    const sec = z.array(sectionRow).safeParse(secRes.data ?? []);
    const gl = z.array(sectionRow).safeParse(glRes.data ?? []);
    const S = sec.success ? sec.data : [];
    const Gl = gl.success ? gl.data : [];
    glossRows = Gl.length;
    const s = (kind: string, idx = 0) => obj(S.find((x) => x.kind === kind && x.idx === idx)?.content);
    const g = (kind: string, idx = 0) => {
      const f = Gl.find((x) => x.kind === kind && x.idx === idx);
      return f ? obj(f.content) : null;
    };
    const n = art.outline.n;
    const head = g("head");
    blocks.push({ label: "Title", original: [art.title ?? ""], translated: head ? [String(head.title ?? "")] : null });
    const intro = g("intro");
    blocks.push({ label: "Introduction", original: arr(s("intro").paragraphs), translated: intro ? arr(intro.paragraphs) : null });
    for (let i = 0; i < n; i++) {
      const o = s("item", i);
      const t = g("item", i);
      blocks.push({
        label: `Item ${i + 1}`,
        original: [String(o.heading ?? ""), ...arr(o.paragraphs), ...arr(o.bullets).map((b) => `• ${b}`)],
        translated: t ? [String(t.heading ?? ""), ...arr(t.paragraphs), ...arr(t.bullets).map((b) => `• ${b}`)] : null,
      });
    }
    const fo = s("faq").items;
    const ft = g("faq")?.items;
    const qa = (v: unknown) => (Array.isArray(v) ? v.flatMap((x) => [String(obj(x).question ?? ""), String(obj(x).answer ?? "")]) : []);
    blocks.push({ label: "FAQ", original: qa(fo), translated: ft ? qa(ft) : null });
    const co = s("conclusion");
    const ct = g("conclusion");
    blocks.push({ label: "Conclusion", original: arr(co.paragraphs), translated: ct ? arr(ct.paragraphs) : null });
  }
  const need = glossRowCount(art.outline.n);

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
        {ready ? (
          <>
            {" · "}
            <span className={`pm-pill ${TONE[light] ?? ""}`}>{light}</span> {LIGHT_TEXT[light]}
          </>
        ) : null}
      </p>
      {flash ? <p className={flash.bad ? "pm-note pm-note-bad" : "pm-note"}>{flash.text}</p> : null}
      {art.status === "failed" || art.status === "canceled" ? <p className="pm-note pm-note-bad">This article was not written ({art.last_error ?? art.status}). It was not charged.</p> : null}
      {art.status === "queued" || art.status === "writing" ? <p className="pm-note">Still being written. Refresh in a minute.</p> : null}

      {art.qa.checks && art.qa.checks.length > 0 ? (
        <section className="pm-section">
          <h2>
            Automatic checks <span className={`pm-pill ${TONE[art.qa.verdict ?? ""] ?? ""}`}>{art.qa.verdict ?? "?"}</span>
          </h2>
          <p className="pm-muted">
            A script checks item count, length, price and year wording, stock phrases, invented experience and English leaks; a second AI model reads the language (below). Neither is proof the text is right: no fact check or image check exists yet, so read the translation before you use the article.
          </p>
          <div className="pm-tablewrap">
            <table className="pm-table">
              <tbody>
                {art.qa.checks.map((c) => (
                  <tr key={c.id}>
                    <td>{c.id}</td>
                    <td><span className={`pm-pill ${TONE[c.status] ?? ""}`}>{c.status}</span></td>
                    <td>{c.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {ready && review.success && review.data.status === "done" ? (
        <section className="pm-section">
          <h2>Language review</h2>
          <p className="pm-muted">
            Read by {review.data.model ?? "a second model"}
            {review.data.cross_model === false
              ? ", the SAME company that wrote the article (only that provider has a key here), so this is a weaker check than an independent one."
              : ", a different company than the one that wrote the article."}{" "}
            Notes are in English; quotes are the original Spanish.
          </p>
          {review.data.issues.length === 0 ? (
            <p>No language issues listed.</p>
          ) : (
            <div className="pm-tablewrap">
              <table className="pm-table">
                <thead><tr><th>Where</th><th>Type</th><th>Quote</th><th>Problem</th><th>Suggested fix</th></tr></thead>
                <tbody>
                  {review.data.issues.map((x, k) => (
                    <tr key={k}><td>{x.where}</td><td>{x.type}</td><td><em>{x.excerpt}</em></td><td>{x.problem}</td><td>{x.fix}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3>Claims to verify before publishing</h3>
          {review.data.risky_claims.length === 0 ? (
            <p>None listed.</p>
          ) : (
            <div className="pm-tablewrap">
              <table className="pm-table">
                <thead><tr><th>Where</th><th>Kind</th><th>Quote</th><th>Why</th></tr></thead>
                <tbody>
                  {review.data.risky_claims.map((x, k) => (
                    <tr key={k}><td>{x.where}</td><td>{x.kind}</td><td><em>{x.excerpt}</em></td><td>{x.note}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
      {ready && review.success && review.data.status === "skipped" ? (
        <p className="pm-note pm-note-warn">The language review did not run ({review.data.reason ?? "unknown"}). The article is marked yellow for that reason; use the translation below to judge it.</p>
      ) : null}

      {ready ? (
        <section className="pm-section">
          <h2>Translation (to read the meaning)</h2>
          <p className="pm-muted">A literal-leaning translation made by AI so you can judge what the Spanish says. It is an aid, not a publishable translation. Asking for one costs no credits.</p>
          <div className="pm-inline" style={{ gap: "0.5rem" }}>
            {(Object.keys(GLOSS_LANGS) as GlossLang[]).map((l) => (
              <span key={l} className="pm-inline" style={{ gap: "0.5rem" }}>
                <Link className="pm-btn pm-btn-ghost pm-btn-sm" href={`/maps/${art.map_run_id}/articles/${art.id}?lang=${l}`}>Show {GLOSS_LANGS[l]}</Link>
              </span>
            ))}
          </div>
          {lang ? (
            <>
              <p style={{ marginTop: "0.75rem" }}>
                {glossRows >= need ? `${GLOSS_LANGS[lang]} translation is complete.` : `${GLOSS_LANGS[lang]}: ${glossRows} of ${need} parts translated${glossRows === 0 ? " (not requested yet)" : ""}.`}
              </p>
              {glossRows < need ? (
                <form action={requestGloss}>
                  <input type="hidden" name="run" value={art.map_run_id} />
                  <input type="hidden" name="article" value={art.id} />
                  <input type="hidden" name="lang" value={lang} />
                  <button type="submit" className="pm-btn pm-btn-brand pm-btn-sm">{glossRows === 0 ? `Translate to ${GLOSS_LANGS[lang]}` : "Translate the missing parts"}</button>
                </form>
              ) : null}
              <div className="pm-tablewrap" style={{ marginTop: "0.75rem" }}>
                <table className="pm-table">
                  <thead><tr><th>Part</th><th>Original</th><th>{GLOSS_LANGS[lang]}</th></tr></thead>
                  <tbody>
                    {blocks.map((b) => (
                      <tr key={b.label}>
                        <td className="pm-nowrap">{b.label}</td>
                        <td>{b.original.map((t, k) => <p key={k}>{t}</p>)}</td>
                        <td>{b.translated ? b.translated.map((t, k) => <p key={k}>{t}</p>) : <span className="pm-muted">not translated yet</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
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
