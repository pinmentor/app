import { redirect } from "next/navigation";
import { z } from "zod";
import { AppFrame } from "@/app/maps/chrome";
import { createClient } from "@/lib/supabase/server";
import { LANGUAGES } from "@/lib/languages";
import { clearSiteContent, connectSite, removeSite, retestSite, syncSiteContent, updateSiteSettings } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Websites — PinMentor" };

const siteRow = z.object({ id: z.string().uuid(), base_url: z.string(), wp_user: z.string(), last4: z.string(), status: z.string(), last_test_code: z.string().nullable(), language: z.string(), locale: z.string(), cta_label: z.string().nullable(),
  content_sync_state: z.string(), content_sync_started_at: z.string().nullable(), content_synced_at: z.string().nullable(), content_sync_error: z.string().nullable(), content_sync_total: z.number(), content_sync_done: z.number() });
const pageRow = z.object({ url: z.string(), title: z.string().nullable(), source: z.string() });
const SYNC_ERRORS: Record<string, string> = { nothing_found: "No pages were found: the site has no readable WordPress API, sitemap or feed. Paste the page addresses instead.", site_not_found: "The site was not found.", db_error: "A database error stopped the sync. Try again." };
const when = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never");

const FLASH: Record<string, { text: string; ok: boolean }> = {
  connected: { text: "Connected. You can now send ready articles to this site as drafts.", ok: true },
  removed: { text: "Site removed.", ok: true },
  settings_saved: { text: "Settings saved.", ok: true },
  sync_started: { text: "Reading your website has started. It runs in the background; use Refresh to see the progress.", ok: true },
  sync_running: { text: "A sync is already running for this site. Wait for it to finish (or refresh in a few minutes).", ok: false },
  sync_no_urls: { text: "No usable address found. Paste full https addresses of pages on this site, one per line.", ok: false },
  content_cleared: { text: "The stored page list of this site was removed.", ok: true },
  bad_settings: { text: "Choose a language and keep the call-to-action text under 60 characters.", ok: false },
  invalid: { text: "Fill in all three fields (the password is at least 8 characters).", ok: false },
  bad_address: { text: "That address is not accepted. Use the full https address of your site, for example https://myblog.com.", ok: false },
  limit: { text: "You can connect up to 5 sites. Remove one first.", ok: false },
  no_master_key: { text: "The server cannot store passwords yet (ENCRYPTION_KEY is missing or wrong in Vercel).", ok: false },
  error: { text: "Something went wrong. Nothing was changed; try again.", ok: false },
};
const CODES: Record<string, string> = {
  bad_login: "WordPress refused the user name or Application Password.",
  no_rest_api: "This address does not answer as WordPress (REST API not found). Check the address.",
  cannot_write: "This user cannot write posts. Use an Editor or Administrator user.",
  host_not_public: "This address points to a private network and is not allowed.",
  dns_failed: "The address could not be found.",
  timeout: "The site did not answer in time.",
  network_error: "The site could not be reached.",
  redirect: "The site redirects. Use the final address (the one the browser ends up on).",
};
const explain = (code: string) => CODES[code] ?? `The site answered with an unexpected result (${code}).`;

export default async function SitesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=%2Fsites");
  const raw = await searchParams;
  const res = await supabase.from("sites").select("id, base_url, wp_user, last4, status, last_test_code, language, locale, cta_label, content_sync_state, content_sync_started_at, content_synced_at, content_sync_error, content_sync_total, content_sync_done").order("created_at");
  const sites = z.array(siteRow).safeParse(res.data ?? []);
  const list = sites.success ? sites.data : [];
  const pages = new Map<string, z.infer<typeof pageRow>[]>();
  for (const s of list) {
    const r = await supabase.from("site_contents").select("url, title, source").eq("site_id", s.id).order("published_at", { ascending: false, nullsFirst: false }).limit(15);
    const rows = z.array(pageRow).safeParse(r.data ?? []);
    pages.set(s.id, rows.success ? rows.data : []);
  }
  const flash = typeof raw.flash === "string" ? FLASH[raw.flash] : undefined;
  const code = typeof raw.code === "string" ? raw.code.slice(0, 60) : "";

  return (
    <AppFrame email={user.email ?? ""}>
      <div className="pm-pagehead">
        <div>
          <h1>Websites</h1>
          <p>Connect each WordPress site once, and say which language its articles are written in. Every ready article then has a “Send to WordPress” button that saves it there as a draft. Nothing is published automatically.</p>
        </div>
      </div>

      {flash ? <p role="status" className={flash.ok ? "pm-note pm-note-ok" : "pm-note pm-note-bad"}>{flash.text}</p> : null}
      {raw.flash === "failed" ? <p role="status" className="pm-note pm-note-bad">Saved, but the test failed. {explain(code)}</p> : null}
      {res.error || !sites.success ? <p className="pm-note pm-note-bad">Could not load your sites. Check that migrations 0021 and 0026 are applied.</p> : null}

      {list.map((s) => (
        <section key={s.id} className="pm-price">
          <div>
            <h2>{s.base_url.replace("https://", "")}</h2>
            <p className="pm-muted" style={{ margin: "0.2rem 0 0" }}>
              {s.status === "connected" ? "Connected" : s.status === "failed" ? explain(s.last_test_code ?? "") : "Not tested yet"} · user {s.wp_user} · password ends …{s.last4}
            </p>
          </div>
          <form action={retestSite}>
            <input type="hidden" name="site" value={s.id} />
            <button type="submit" className="pm-btn">Test again</button>
          </form>
          <details className="pm-more" open={s.content_sync_state === "running" || s.content_sync_state === "failed" || undefined}>
            <summary>
              Website content · {s.content_sync_state === "running" ? `reading… ${s.content_sync_done} of ${s.content_sync_total} pages` : s.content_sync_total > 0 ? `${s.content_sync_total} pages known, last sync ${when(s.content_synced_at)}` : "not read yet"}
            </summary>
            <p className="pm-muted">
              We read only the page titles, headings and short descriptions of your website (never the full text), so a new map can tell which topics you already cover and mark them “already exists”.
              {s.content_sync_state === "running" ? " A sync is running." : ""}
              {s.content_sync_state === "failed" ? ` The last sync stopped: ${SYNC_ERRORS[s.content_sync_error ?? ""] ?? s.content_sync_error ?? "unknown error"}` : ""}
            </p>
            <div className="pm-inline" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
              <form action={syncSiteContent}>
                <input type="hidden" name="site" value={s.id} />
                <input type="hidden" name="mode" value="auto" />
                <button type="submit" className="pm-btn pm-btn-sm" disabled={s.content_sync_state === "running"}>Sync now</button>
              </form>
              <a href="/sites" className="pm-btn pm-btn-quiet pm-btn-sm">Refresh</a>
            </div>
            <details className="pm-more">
              <summary>Add pages by address instead</summary>
              <form action={syncSiteContent} className="pm-keyform">
                <input type="hidden" name="site" value={s.id} />
                <input type="hidden" name="mode" value="urls" />
                <label className="pm-field">Page addresses of this site (one per line, up to 500)
                  <textarea name="urls" rows={5} className="pm-input" placeholder={`${s.base_url}/my-post/`} />
                </label>
                <button type="submit" className="pm-btn pm-btn-sm" disabled={s.content_sync_state === "running"}>Read these pages</button>
              </form>
            </details>
            {(pages.get(s.id) ?? []).length > 0 ? (
              <div className="pm-tablewrap">
                <table className="pm-table">
                  <thead><tr><th>Latest pages</th><th>Source</th></tr></thead>
                  <tbody>
                    {(pages.get(s.id) ?? []).map((p) => (
                      <tr key={p.url}><td>{p.title ?? p.url.replace("https://", "")}</td><td>{p.source}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {s.content_sync_total > 0 ? (
              <form action={clearSiteContent}>
                <input type="hidden" name="site" value={s.id} />
                <button type="submit" className="pm-btn pm-btn-quiet pm-btn-sm">Forget the stored page list</button>
              </form>
            ) : null}
          </details>
          <details className="pm-more">
            <summary>Language and call-to-action · {LANGUAGES.find((l) => l.code === s.language)?.name ?? s.language} ({s.locale}){s.cta_label ? ` · “${s.cta_label}”` : ""}</summary>
            <form action={updateSiteSettings} className="pm-keyform">
              <input type="hidden" name="site" value={s.id} />
              <label className="pm-field">Language of the articles
                <select name="language" defaultValue={s.language} className="pm-input">
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>{l.name} ({l.locale})</option>
                  ))}
                </select>
              </label>
              <label className="pm-field">Call-to-action text (the same on every article of this site)
                <input name="cta" defaultValue={s.cta_label ?? ""} maxLength={60} className="pm-input" autoComplete="off" />
              </label>
              <button type="submit" className="pm-btn pm-btn-sm">Save</button>
            </form>
          </details>
          <details className="pm-more">
            <summary>Remove</summary>
            <form action={removeSite}>
              <input type="hidden" name="site" value={s.id} />
              <p className="pm-muted">Removes the connection and the stored password. Drafts already in WordPress stay there.</p>
              <button type="submit" className="pm-btn pm-btn-sm">Remove this site</button>
            </form>
          </details>
        </section>
      ))}

      <section className="pm-section">
        <h2>{list.length === 0 ? "Connect your WordPress site" : "Connect another site"}</h2>
        <form action={connectSite} className="pm-keyform">
          <label className="pm-field">Site address
            <input name="address" required placeholder="https://myblog.com" className="pm-input" autoComplete="off" />
          </label>
          <label className="pm-field">WordPress user name
            <input name="user" required className="pm-input" autoComplete="off" />
          </label>
          <label className="pm-field">Application Password
            <input name="password" type="password" required minLength={8} className="pm-input" autoComplete="new-password" />
          </label>
          <button type="submit" className="pm-btn pm-btn-primary">Connect and test</button>
        </form>
        <details className="pm-more">
          <summary>Where do I get an Application Password?</summary>
          <p>In WordPress: Users → Profile → “Application Passwords” → type a name (for example PinMentor) → “Add New Application Password”. Copy the password it shows once. It works only for the REST API and can be revoked there at any time. Your site must use https and the user must be an Editor or Administrator.</p>
        </details>
      </section>
    </AppFrame>
  );
}
