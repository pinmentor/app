import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { GLOSS_LANGS, glossRowCount, isGlossLang, type GlossLang } from "@/modules/articles/gloss";
import { lightOf, storedReviewSchema, type Light } from "@/modules/articles/review";
import { AppFrame } from "../../../chrome";
import { requestGloss, sendToWordPress } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Article — PinMentor" };

const rowSchema = z.object({
  id: z.string().uuid(), map_run_id: z.string().uuid(), status: z.string(), title: z.string().nullable(), slug: z.string().nullable(), keyword: z.string(),
  body_html: z.string().nullable(), word_count: z.number().nullable(), last_error: z.string().nullable(),
  qa: z.object({ verdict: z.string().optional(), checks: z.array(z.object({ id: z.string(), status: z.string(), summary: z.string() })).optional() }).passthrough(),
  review: z.unknown(), outline: z.object({ n: z.number() }).passthrough(),
  meta_description: z.string().nullable(), schema_json: z.unknown(), wp_edit_url: z.string().nullable(), links: z.array(z.object({ role: z.string(), title: z.string(), slug: z.string() })).catch([]),
});
const sectionRow = z.object({ kind: z.string(), idx: z.number(), content: z.unknown() });

/** Own stylesheet for the preview: the article HTML is generated and escaped by our code, and shown in a sandbox with no scripts. */
const PREVIEW_CSS =
  "body{font:16px/1.65 system-ui,sans-serif;max-width:46rem;margin:1.5rem auto;padding:0 1rem;color:#1c2321}h1{font-size:1.8rem;line-height:1.25}h2{font-size:1.3rem;margin-top:2rem}h3{font-size:1.05rem}ul{padding-left:1.25rem}";

const LIGHT_BOX: Record<Light, { title: string; text: string }> = {
  green: { title: "Looks good", text: "All checks passed. Read it once, then it is ready to use." },
  yellow: { title: "Check before use", text: "Some checks raised a flag. Open the Checks tab to see what." },
  red: { title: "Do not use yet", text: "A serious problem was found. Open the Checks tab to see what." },
};
const TONE: Record<string, string> = { pass: "pm-pill-succeeded", flag: "pm-pill-warn", fail: "pm-pill-dead" };
const FLASH: Record<string, { text: string; bad: boolean }> = {
  started: { text: "Translation started. Refresh in a minute or two; parts appear as they finish.", bad: false },
  notready: { text: "This article is not finished, so it cannot be translated yet.", bad: true },
  gone: { text: "Article not found.", bad: true },
  sent: { text: "Saved in WordPress as a draft. Open it there, check it, and publish when you are happy.", bad: false },
  sent_noschema: { text: "Saved as a draft, but WordPress removed the schema (JSON-LD) script: this user lacks the unfiltered_html right. The text is fine; add schema with an SEO plugin or use an Administrator user.", bad: true },
  sent_unsaved: { text: "The draft was created in WordPress, but PinMentor could not record it. Pressing the button again may create a second draft.", bad: true },
  no_site: { text: "No WordPress site is connected yet. Connect one on the WordPress page, then come back.", bad: true },
  site_choice: { text: "You have several sites and this project has none chosen. Remove the ones you do not use on the WordPress page.", bad: true },
  no_master_key: { text: "The stored password cannot be read (ENCRYPTION_KEY changed or missing). Connect the site again.", bad: true },
  wp_failed: { text: "WordPress did not accept the draft.", bad: true },
  error: { text: "Something went wrong. Nothing was changed; try again.", bad: true },
};
const TABS = [
  { key: "read", label: "Read" },
  { key: "checks", label: "Checks" },
  { key: "translation", label: "Translation" },
] as const;
type Tab = (typeof TABS)[number]["key"];

type Block = { label: string; original: string[]; translated: string[] | null };
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

export default async function ArticlePage({ params, searchParams }: { params: Promise<{ id: string; articleId: string }>; searchParams: Promise<{ tab?: string; lang?: string; flash?: string; code?: string }> }) {
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
    .select("id, map_run_id, status, title, slug, keyword, body_html, word_count, last_error, qa, review, outline, meta_description, schema_json, links, wp_edit_url")
    .eq("id", ids.data.articleId)
    .eq("map_run_id", ids.data.id)
    .maybeSingle();
  const a = rowSchema.safeParse(res.data);
  if (!a.success) notFound();
  const art = a.data;
  const ready = art.status === "ready";
  const light = lightOf(art.qa.verdict);
  const review = storedReviewSchema.safeParse(art.review);
  const tab: Tab = TABS.some((t) => t.key === sp.tab) ? (sp.tab as Tab) : "read";
  const lang: GlossLang = isGlossLang(sp.lang) ? sp.lang : "bn";
  const flash = sp.flash ? FLASH[sp.flash] : undefined;
  const base = `/maps/${art.map_run_id}/articles/${art.id}`;
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><style>${PREVIEW_CSS}</style></head><body>${art.body_html ?? ""}</body></html>`;

  // translation tab: original blocks next to their translation
  const blocks: Block[] = [];
  let glossRows = 0;
  if (ready && tab === "translation") {
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
    const head = g("head");
    blocks.push({ label: "Title", original: [art.title ?? ""], translated: head ? [String(head.title ?? "")] : null });
    const intro = g("intro");
    blocks.push({ label: "Introduction", original: arr(s("intro").paragraphs), translated: intro ? arr(intro.paragraphs) : null });
    for (let i = 0; i < art.outline.n; i++) {
      const o = s("item", i);
      const t = g("item", i);
      blocks.push({
        label: `Item ${i + 1}`,
        original: [String(o.heading ?? ""), ...arr(o.paragraphs), ...arr(o.bullets).map((b) => `• ${b}`)],
        translated: t ? [String(t.heading ?? ""), ...arr(t.paragraphs), ...arr(t.bullets).map((b) => `• ${b}`)] : null,
      });
    }
    const qa = (v: unknown) => (Array.isArray(v) ? v.flatMap((x) => [String(obj(x).question ?? ""), String(obj(x).answer ?? "")]) : []);
    const ft = g("faq")?.items;
    blocks.push({ label: "FAQ", original: qa(s("faq").items), translated: ft ? qa(ft) : null });
    const ct = g("conclusion");
    blocks.push({ label: "Conclusion", original: arr(s("conclusion").paragraphs), translated: ct ? arr(ct.paragraphs) : null });
  }
  const need = glossRowCount(art.outline.n);

  const checks = art.qa.checks ?? [];
  const flagged = checks.filter((c) => c.status !== "pass");
  const passed = checks.filter((c) => c.status === "pass");
  const rv = review.success && review.data.status === "done" ? review.data : null;

  return (
    <AppFrame email={user.email ?? ""}>
      <p>
        <Link href={`/maps/${art.map_run_id}/batches`}>&larr; Back to batches</Link>
      </p>
      <h1>{art.title ?? art.keyword}</h1>
      <p className="pm-muted">
        {art.keyword}
        {art.word_count !== null ? ` · ${art.word_count} words` : ""}
        {art.slug ? ` · /${art.slug}` : ""}
      </p>
      {flash ? (
        <p className={flash.bad ? "pm-note pm-note-bad" : "pm-note"}>
          {flash.text}
          {sp.flash === "wp_failed" && sp.code ? ` (${sp.code.slice(0, 40).replace(/[^a-z0-9_]/gi, "")})` : ""}
          {sp.flash === "no_site" || sp.flash === "site_choice" || sp.flash === "wp_failed" ? <> <Link href="/sites">WordPress page &rarr;</Link></> : null}
        </p>
      ) : null}
      {art.status === "failed" || art.status === "canceled" ? <p className="pm-note pm-note-bad">This article was not written ({art.last_error ?? art.status}). It was not charged.</p> : null}
      {art.status === "queued" || art.status === "writing" ? <p className="pm-note">Still being written. Refresh in a minute.</p> : null}

      {ready ? (
        <>
          <div className={`pm-light pm-light-${light}`} role="status">
            <i aria-hidden="true" />
            <div>
              <b>{LIGHT_BOX[light].title}</b>
              <span>{LIGHT_BOX[light].text}</span>
            </div>
          </div>

          <div className="pm-inline" style={{ gap: "0.75rem", margin: "0.75rem 0" }}>
            <form action={sendToWordPress}>
              <input type="hidden" name="run" value={art.map_run_id} />
              <input type="hidden" name="article" value={art.id} />
              <button type="submit" className={art.wp_edit_url ? "pm-btn" : "pm-btn pm-btn-primary"}>{art.wp_edit_url ? "Update the WordPress draft" : "Send to WordPress as draft"}</button>
            </form>
            {art.wp_edit_url ? <a href={art.wp_edit_url} target="_blank" rel="noopener noreferrer">Open the draft in WordPress &rarr;</a> : null}
          </div>

          <nav className="pm-tabs" aria-label="Article views">
            {TABS.map((t) =>
              t.key === tab ? (
                <span key={t.key} className="pm-tab pm-tab-on" aria-current="page">{t.label}{t.key === "checks" && flagged.length > 0 ? ` (${flagged.length})` : ""}</span>
              ) : (
                <Link key={t.key} href={`${base}?tab=${t.key}`} className="pm-tab">{t.label}{t.key === "checks" && flagged.length > 0 ? ` (${flagged.length})` : ""}</Link>
              ),
            )}
          </nav>

          {tab === "read" && art.body_html ? (
            <iframe title="Article preview" sandbox="" srcDoc={srcDoc} style={{ width: "100%", height: "75vh", border: "1px solid var(--line)", borderRadius: "0.75rem", background: "#fff" }} />
          ) : null}

          {tab === "checks" ? (
            <section>
              {flagged.length === 0 && !rv?.issues.length && !rv?.risky_claims.length ? <p>Nothing needs your attention.</p> : null}
              {flagged.length > 0 ? (
                <>
                  <h2>Needs your attention</h2>
                  <ul className="pm-checks">
                    {flagged.map((c) => (
                      <li key={c.id}><span className={`pm-pill ${TONE[c.status] ?? ""}`}>{c.status}</span> {c.summary}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              {rv && rv.issues.length > 0 ? (
                <>
                  <h2>Language problems found</h2>
                  <div className="pm-tablewrap">
                    <table className="pm-table">
                      <thead><tr><th>Where</th><th>Quote</th><th>Problem</th><th>Suggested fix</th></tr></thead>
                      <tbody>
                        {rv.issues.map((x, k) => (
                          <tr key={k}><td>{x.where}</td><td><em>{x.excerpt}</em></td><td>{x.problem}</td><td>{x.fix}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : null}
              {rv && rv.risky_claims.length > 0 ? (
                <>
                  <h2>Claims to verify before publishing</h2>
                  <div className="pm-tablewrap">
                    <table className="pm-table">
                      <thead><tr><th>Where</th><th>Quote</th><th>Why</th></tr></thead>
                      <tbody>
                        {rv.risky_claims.map((x, k) => (
                          <tr key={k}><td>{x.where}</td><td><em>{x.excerpt}</em></td><td>{x.note}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : null}
              {passed.length > 0 ? (
                <details className="pm-more">
                  <summary>{passed.length} check{passed.length === 1 ? "" : "s"} passed</summary>
                  <ul className="pm-checks">
                    {passed.map((c) => (
                      <li key={c.id}><span className={`pm-pill ${TONE.pass}`}>pass</span> {c.summary}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
              <details className="pm-more">
                <summary>Publishing data (meta description, schema, links)</summary>
                <p><strong>Meta description</strong> ({(art.meta_description ?? "").length} characters)<br />{art.meta_description ?? "Not created."}</p>
                <p><strong>Schema</strong>: {Array.isArray(art.schema_json) ? (art.schema_json as { "@type"?: string }[]).map((n) => n["@type"]).join(", ") : "Not created."}</p>
                <p><strong>Planned internal links</strong>{art.links.length === 0 ? ": none." : ":"}</p>
                {art.links.length > 0 ? <ul className="pm-checks">{art.links.map((l) => <li key={l.slug}><span className="pm-pill">{l.role}</span> {l.title} <span className="pm-muted">/{l.slug}/</span></li>)}</ul> : null}
                <p className="pm-muted">Links go in when the article is published, and only to articles that are live.</p>
              </details>
              <p className="pm-muted" style={{ marginTop: "1rem" }}>
                {rv ? `Language read by ${rv.model ?? "a second model"}${rv.cross_model === false ? " (the same company that wrote it, so a weaker check)" : ""}. ` : ""}
                These checks lower the risk; they do not prove the text is right. Read the translation before you use the article.
              </p>
            </section>
          ) : null}

          {tab === "translation" ? (
            <section>
              <div className="pm-seg" role="group" aria-label="Language">
                {(Object.keys(GLOSS_LANGS) as GlossLang[]).map((l) => (
                  <Link key={l} href={`${base}?tab=translation&lang=${l}`} aria-current={l === lang ? "true" : undefined}>{GLOSS_LANGS[l]}</Link>
                ))}
              </div>
              {glossRows >= need ? (
                <p className="pm-muted" style={{ marginTop: "0.75rem" }}>Translation complete. It is a literal aid to understand the meaning, not a publishable translation.</p>
              ) : (
                <div className="pm-inline" style={{ gap: "0.75rem", margin: "0.75rem 0" }}>
                  <form action={requestGloss}>
                    <input type="hidden" name="run" value={art.map_run_id} />
                    <input type="hidden" name="article" value={art.id} />
                    <input type="hidden" name="lang" value={lang} />
                    <button type="submit" className="pm-btn pm-btn-primary">{glossRows === 0 ? `Translate to ${GLOSS_LANGS[lang]}` : "Translate the missing parts"}</button>
                  </form>
                  <span className="pm-muted">{glossRows === 0 ? "Free. Takes 1–2 minutes; refresh after." : `${glossRows} of ${need} parts done. Refresh to see more.`}</span>
                </div>
              )}
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
            </section>
          ) : null}
        </>
      ) : null}
    </AppFrame>
  );
}
