import { z } from "zod";
import { AdminShell } from "@/app/admin/admin-nav";
import { requireAdmin } from "@/lib/admin/guard";
import { canManageSecrets } from "@/lib/admin/roles";
import { decryptSecret, masterKeyStatus } from "@/lib/secrets/crypto";
import { envSecret, isSecretProvider, SECRET_PROVIDER_IDS, SECRET_PROVIDERS } from "@/lib/secrets/providers";
import { secretRowSchema, type SecretRow } from "@/lib/secrets/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { removeKey, saveKey, testKey } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "API keys — PinMentor Admin" };

const FLASH: Record<string, { text: (name: string, code?: string) => string; ok: boolean }> = {
  saved: { text: (n) => `${n} key saved (encrypted). Press Test connection to check it.`, ok: true },
  removed: { text: (n) => `${n} key removed from the admin page. A Vercel environment variable, if there is one, takes over.`, ok: true },
  nothing_to_remove: { text: (n) => `There was no ${n} key to remove.`, ok: false },
  test_ok: { text: (n) => `${n} accepted the key.`, ok: true },
  test_failed: { text: (n, c) => `${n} did not accept the key (${c ?? "unknown"}). Check the key and that the account is active.`, ok: false },
  not_set: { text: (n) => `No ${n} key is set yet.`, ok: false },
  cannot_decrypt: { text: (n) => `The stored ${n} key cannot be read with the current ENCRYPTION_KEY. Save the key again.`, ok: false },
  invalid: { text: (n) => `That ${n} key is not valid: no spaces or line breaks, at least 10 characters.`, ok: false },
  no_master_key: { text: () => "ENCRYPTION_KEY is not set in Vercel, so keys cannot be stored. See the note above.", ok: false },
  bad_master_key: { text: () => "ENCRYPTION_KEY is set but is not 32 bytes of base64. See the note above.", ok: false },
  forbidden: { text: () => "Only a superadmin can change API keys.", ok: false },
  error: { text: () => "Something went wrong. Nothing was changed; try again.", ok: false },
};

const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { role } = await requireAdmin();
  const raw = await searchParams;
  const mayManage = canManageSecrets(role);
  const master = masterKeyStatus();

  const listRes = await createAdminClient().rpc("admin_secret_list");
  const parsed = z.array(secretRowSchema).safeParse(listRes.data ?? []);
  const loadFailed = Boolean(listRes.error) || !parsed.success;
  const rows = new Map<string, SecretRow>((parsed.success ? parsed.data : []).map((r) => [r.provider, r]));

  // can the stored ciphertext still be read with the current ENCRYPTION_KEY? (only checked, never shown)
  const readable = new Map<string, boolean>();
  if (master === "ok") {
    for (const id of rows.keys()) {
      if (!isSecretProvider(id)) continue;
      const { data } = await createAdminClient().rpc("secret_get_ciphertext", { p_provider: id });
      try {
        decryptSecret(id, z.string().parse(data));
        readable.set(id, true);
      } catch {
        readable.set(id, false);
      }
    }
  }

  const flashKey = typeof raw.flash === "string" ? raw.flash : undefined;
  const flashProvider = typeof raw.p === "string" && isSecretProvider(raw.p) ? SECRET_PROVIDERS[raw.p].label : "The";
  const flashCode = typeof raw.code === "string" && /^[a-z0-9_.-]{1,40}$/.test(raw.code) ? raw.code : undefined;
  const flash = flashKey ? FLASH[flashKey] : undefined;

  return (
    <AdminShell current="keys" role={role}>
      <div className="pm-pagehead">
        <div>
          <h1>API keys</h1>
          <p>
            Keys for the AI and search services PinMentor calls. They are encrypted before they are stored and can never be
            shown again, only replaced.
          </p>
        </div>
      </div>

      {flash ? (
        <p role="status" className={flash.ok ? "pm-note pm-note-ok" : "pm-note pm-note-bad"}>
          {flash.text(flashProvider, flashCode)}
        </p>
      ) : null}
      {loadFailed ? (
        <p className="pm-note pm-note-bad">Could not load the key list. Check that migration 0007 is applied.</p>
      ) : null}

      {master !== "ok" ? (
        <div className="pm-note pm-note-warn">
          <strong>{master === "missing" ? "ENCRYPTION_KEY is not set." : "ENCRYPTION_KEY is not valid."}</strong> It is the one
          secret that cannot live on this page: it encrypts all the others. Create it once, add it in Vercel under Settings,
          Environment Variables as <code>ENCRYPTION_KEY</code>, then redeploy. To create one, run{" "}
          <code>openssl rand -base64 32</code> in a terminal, or <code>node -e &quot;console.log(require(&apos;crypto&apos;).randomBytes(32).toString(&apos;base64&apos;))&quot;</code>.
          Keep a copy somewhere safe: if it is lost, saved keys have to be entered again.
        </div>
      ) : null}

      <div className="pm-keys">
        {SECRET_PROVIDER_IDS.map((id) => {
          const def = SECRET_PROVIDERS[id];
          const row = rows.get(id);
          const envHas = envSecret(def, process.env) !== null;
          const unreadable = row !== undefined && readable.get(id) === false;
          const state = row ? (unreadable ? "unreadable" : "admin") : envHas ? "env" : "none";
          return (
            <section key={id} className="pm-keycard" aria-labelledby={`k-${id}`}>
              <div className="pm-keyhead">
                <div>
                  <h2 id={`k-${id}`}>{def.label}</h2>
                  <p>{def.purpose}</p>
                </div>
                <span className={`pm-pill ${state === "admin" || state === "env" ? "pm-pill-succeeded" : state === "unreadable" ? "pm-pill-dead" : ""}`}>
                  {state === "admin" ? "Saved here" : state === "env" ? "From Vercel" : state === "unreadable" ? "Cannot be read" : "Not set"}
                </span>
              </div>

              {row ? (
                <p className="pm-keymeta">
                  Ends in <code>{row.last4}</code>, saved {when(row.set_at)} UTC{row.set_by_email ? ` by ${row.set_by_email}` : ""}.
                  {row.last_tested_at ? (
                    <>
                      {" "}
                      Last test {when(row.last_tested_at)} UTC:{" "}
                      <strong className={row.last_test_ok ? "pm-tone-succeeded" : "pm-tone-dead"}>
                        {row.last_test_ok ? "accepted" : `failed (${row.last_test_code ?? "unknown"})`}
                      </strong>
                      .
                    </>
                  ) : (
                    " Not tested yet."
                  )}
                </p>
              ) : state === "env" ? (
                <p className="pm-keymeta">Using the value set in Vercel. Saving a key here takes priority over it.</p>
              ) : (
                <p className="pm-keymeta">Get it from {def.where}.</p>
              )}
              {unreadable ? (
                <p className="pm-note pm-note-bad">This key was saved with a different ENCRYPTION_KEY. Save it again.</p>
              ) : null}

              {mayManage ? (
                <div className="pm-keyforms">
                  <form action={saveKey} className="pm-keyform">
                    <input type="hidden" name="provider" value={id} />
                    {def.kind === "single" ? (
                      <label className="pm-field">
                        {row ? "Replace key" : "API key"}
                        <input
                          name="key"
                          type="password"
                          required
                          minLength={10}
                          maxLength={400}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="Paste the key"
                          className="pm-input"
                          disabled={master !== "ok"}
                        />
                      </label>
                    ) : (
                      <>
                        <label className="pm-field">
                          Login
                          <input name="login" required minLength={3} maxLength={120} autoComplete="off" spellCheck={false} placeholder="Your DataForSEO login" className="pm-input" disabled={master !== "ok"} />
                        </label>
                        <label className="pm-field">
                          {row ? "Replace API password" : "API password"}
                          <input name="password" type="password" required minLength={6} maxLength={200} autoComplete="off" spellCheck={false} placeholder="Paste the API password" className="pm-input" disabled={master !== "ok"} />
                        </label>
                      </>
                    )}
                    <button type="submit" className="pm-btn pm-btn-brand" disabled={master !== "ok"}>
                      {row ? "Replace key" : "Save key"}
                    </button>
                  </form>

                  <div className="pm-inline">
                    {state === "admin" || state === "env" ? (
                      <form action={testKey}>
                        <input type="hidden" name="provider" value={id} />
                        <button type="submit" className="pm-btn pm-btn-quiet pm-btn-sm">
                          Test connection
                        </button>
                      </form>
                    ) : null}
                    {row ? (
                      <form action={removeKey}>
                        <input type="hidden" name="provider" value={id} />
                        <button type="submit" className="pm-btn pm-btn-ghost pm-btn-sm">
                          Remove key
                        </button>
                      </form>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </section>
          );
        })}
      </div>

      {!mayManage ? <p className="pm-note pm-note-warn">Only a superadmin can add, test or remove keys.</p> : null}
    </AdminShell>
  );
}
