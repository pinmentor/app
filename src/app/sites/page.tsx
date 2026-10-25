import { redirect } from "next/navigation";
import { z } from "zod";
import { AppFrame } from "@/app/maps/chrome";
import { createClient } from "@/lib/supabase/server";
import { connectSite, removeSite, retestSite } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "WordPress — PinMentor" };

const siteRow = z.object({ id: z.string().uuid(), base_url: z.string(), wp_user: z.string(), last4: z.string(), status: z.string(), last_test_code: z.string().nullable() });

const FLASH: Record<string, { text: string; ok: boolean }> = {
  connected: { text: "Connected. You can now send ready articles to this site as drafts.", ok: true },
  removed: { text: "Site removed.", ok: true },
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
  const res = await supabase.from("sites").select("id, base_url, wp_user, last4, status, last_test_code").order("created_at");
  const sites = z.array(siteRow).safeParse(res.data ?? []);
  const list = sites.success ? sites.data : [];
  const flash = typeof raw.flash === "string" ? FLASH[raw.flash] : undefined;
  const code = typeof raw.code === "string" ? raw.code.slice(0, 60) : "";

  return (
    <AppFrame email={user.email ?? ""}>
      <div className="pm-pagehead">
        <div>
          <h1>WordPress</h1>
          <p>Connect your site once. Then every ready article has a “Send to WordPress” button that saves it there as a draft. Nothing is published automatically.</p>
        </div>
      </div>

      {flash ? <p role="status" className={flash.ok ? "pm-note pm-note-ok" : "pm-note pm-note-bad"}>{flash.text}</p> : null}
      {raw.flash === "failed" ? <p role="status" className="pm-note pm-note-bad">Saved, but the test failed. {explain(code)}</p> : null}
      {res.error || !sites.success ? <p className="pm-note pm-note-bad">Could not load your sites. Check that migration 0021 is applied.</p> : null}

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
