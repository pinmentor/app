import { redirect } from "next/navigation";
import { z } from "zod";
import { AppFrame } from "@/app/maps/chrome";
import { LANGUAGES } from "@/lib/languages";
import { createClient } from "@/lib/supabase/server";
import { MAX_ITEMS, REJECT_TEXT, type RejectReason } from "@/modules/keywords/csv";
import { deleteKeywords, importKeywords } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Keywords — PinMentor" };

const rows = z.array(z.object({ id: z.string().uuid(), text: z.string(), lang: z.string(), tags: z.array(z.string()), source: z.string(), created_at: z.string() }));

const FLASH: Record<string, { text: string; ok: boolean }> = {
  deleted: { text: "Removed from your library.", ok: true },
  invalid: { text: "Choose a language and paste some keywords or pick a file.", ok: false },
  too_big: { text: "That file is too large (512 KB at most). Split it into smaller files.", ok: false },
  nothing: { text: "No usable keywords were found in that text.", ok: false },
  full: { text: "Your library is full (5,000 keywords). Remove some first.", ok: false },
  pick: { text: "Tick at least one keyword to remove.", ok: false },
  error: { text: "Something went wrong. Nothing was changed; try again.", ok: false },
};

function why(raw: string | string[] | undefined): string[] {
  if (typeof raw !== "string" || raw === "") return [];
  return raw.split(",").flatMap((p) => {
    const m = /^(\d{1,6})\.([a-z_]+)$/.exec(p);
    const reason = m?.[2] as RejectReason | undefined;
    return m && reason && reason in REJECT_TEXT ? [`line ${m[1]}: ${REJECT_TEXT[reason]}`] : [];
  });
}
const num = (v: string | string[] | undefined) => (typeof v === "string" && /^\d{1,6}$/.test(v) ? Number(v) : 0);

export default async function KeywordsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=%2Fkeywords");
  const raw = await searchParams;
  const q = typeof raw.q === "string" ? raw.q.trim().slice(0, 100) : "";

  let query = supabase.from("keyword_library").select("id, text, lang, tags, source, created_at").eq("kind", "keyword").order("created_at", { ascending: false }).limit(200);
  if (q) query = query.ilike("text", `%${q.replace(/[%_]/g, " ")}%`);
  const [res, total] = await Promise.all([query, supabase.from("keyword_library").select("id", { count: "exact", head: true }).eq("kind", "keyword")]);
  const parsed = rows.safeParse(res.data ?? []);
  const list = parsed.success ? parsed.data : [];
  const flash = typeof raw.flash === "string" ? FLASH[raw.flash] : undefined;
  const reasons = why(raw.why);

  return (
    <AppFrame email={user.email ?? ""}>
      <div className="pm-pagehead">
        <div>
          <h1>Keywords</h1>
          <p>Keep your own keywords here: paste a list or upload a CSV. They are free to save. When a map is started, it can use them next to (or instead of) the ones it finds itself.</p>
        </div>
      </div>

      {flash ? <p role="status" className={flash.ok ? "pm-note pm-note-ok" : "pm-note pm-note-bad"}>{flash.text}</p> : null}
      {raw.flash === "imported" ? (
        <div role="status" className="pm-note pm-note-ok">
          <b>{num(raw.added)} added</b> · {num(raw.dup)} already there · {num(raw.bad)} skipped{raw.cut === "1" ? ` · only the first ${MAX_ITEMS} were read` : ""}
          {reasons.length > 0 ? (
            <ul>
              {reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
              {num(raw.bad) > reasons.length ? <li>and {num(raw.bad) - reasons.length} more</li> : null}
            </ul>
          ) : null}
        </div>
      ) : null}
      {res.error || !parsed.success ? <p className="pm-note pm-note-bad">Could not load your keywords. Check that migration 0027 is applied, then refresh.</p> : null}

      <section className="pm-section">
        <h2>Add keywords</h2>
        <form action={importKeywords} className="pm-keyform" encType="multipart/form-data">
          <label className="pm-field">Language of these keywords
            <select name="lang" defaultValue="es" className="pm-input">
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.name}</option>
              ))}
            </select>
          </label>
          <label className="pm-field">Paste them (one per line, or a single comma-separated line)
            <textarea name="text" rows={6} className="pm-input" placeholder={"peinados faciles\npeinados con trenzas"} />
          </label>
          <label className="pm-field">…or upload a CSV or text file (a header like “keyword” or “query” is recognised; optional “tags” column)
            <input type="file" name="file" accept=".csv,.txt,text/csv,text/plain" className="pm-input" />
          </label>
          <label className="pm-field">Tags for all of them (optional, comma-separated)
            <input name="tags" maxLength={300} className="pm-input" autoComplete="off" />
          </label>
          <button type="submit" className="pm-btn pm-btn-primary">Save to my library</button>
        </form>
        <details className="pm-more">
          <summary>How are duplicates handled?</summary>
          <p>The same keyword in another spelling (capitals, accents, word order, plural) counts as one and is saved once. Rows that cannot be used (web addresses, whole sentences, filler words only) are skipped and listed with their line number. If you upload a file, a file wins over the pasted text.</p>
        </details>
      </section>

      <section className="pm-section">
        <h2>Your library ({total.count ?? 0})</h2>
        <form method="get" className="pm-inline">
          <input name="q" defaultValue={q} placeholder="Search" aria-label="Search keywords" className="pm-input" style={{ width: "16rem" }} />
          <button type="submit" className="pm-btn pm-btn-sm">Search</button>
        </form>
        {list.length === 0 ? (
          <div className="pm-empty">
            <h2>{q ? "No keyword matches" : "No saved keywords yet"}</h2>
            <p>{q ? "Try another search." : "Add some above. They stay here until you remove them."}</p>
          </div>
        ) : (
          <form action={deleteKeywords}>
            <div className="pm-tablewrap">
              <table className="pm-table">
                <thead>
                  <tr><th aria-label="Select" /><th>Keyword</th><th>Language</th><th>Tags</th><th>From</th><th>Added</th></tr>
                </thead>
                <tbody>
                  {list.map((k) => (
                    <tr key={k.id}>
                      <td><input type="checkbox" name="id" value={k.id} aria-label={`Select ${k.text}`} /></td>
                      <td>{k.text}</td>
                      <td>{k.lang}</td>
                      <td>{k.tags.join(", ") || "—"}</td>
                      <td>{k.source === "csv" ? "file" : k.source}</td>
                      <td className="pm-nowrap">{k.created_at.slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="pm-muted">Showing the {list.length} newest{(total.count ?? 0) > list.length && !q ? "; search to find others" : ""}.</p>
            <button type="submit" className="pm-btn pm-btn-sm">Remove ticked</button>
          </form>
        )}
      </section>
    </AppFrame>
  );
}
