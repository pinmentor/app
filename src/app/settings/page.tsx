import { redirect } from "next/navigation";
import { z } from "zod";
import { AppFrame } from "@/app/maps/chrome";
import { createClient } from "@/lib/supabase/server";
import { setReviewLanguage } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings — PinMentor" };

const FLASH: Record<string, { text: string; ok: boolean }> = {
  saved: { text: "Saved.", ok: true },
  invalid: { text: "Choose one of the two languages.", ok: false },
  forbidden: { text: "Only the owner or an admin of the workspace can change this.", ok: false },
  error: { text: "Something went wrong. Nothing was changed; try again.", ok: false },
};
const wsRows = z.array(z.object({ id: z.string().uuid(), name: z.string(), review_language: z.enum(["bn", "en"]) }));

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=%2Fsettings");
  const raw = await searchParams;
  const res = await supabase.from("workspaces").select("id, name, review_language").order("created_at").limit(1);
  const ws = wsRows.safeParse(res.data ?? []);
  const current = ws.success ? ws.data[0] : undefined;
  const flash = typeof raw.flash === "string" ? FLASH[raw.flash] : undefined;

  return (
    <AppFrame email={user.email ?? ""}>
      <div className="pm-pagehead">
        <div>
          <h1>Settings</h1>
          <p>Your account and how review screens behave.</p>
        </div>
      </div>
      {flash ? <p role="status" className={flash.ok ? "pm-note pm-note-ok" : "pm-note pm-note-bad"}>{flash.text}</p> : null}
      {res.error || !ws.success ? <p className="pm-note pm-note-bad">Could not load your settings. Check that migration 0026 is applied, then refresh.</p> : null}

      <section className="pm-section">
        <h2>Account</h2>
        <p>Signed in as <b>{user.email}</b>{current ? <> · workspace “{current.name}”</> : null}</p>
      </section>

      {current ? (
        <section className="pm-section">
          <h2>Translation for review</h2>
          <p>Articles and pins are written in the language of each website. To check them without reading that language, the review screens show a translation next to the text. Choose the one it opens with. It applies to everyone in this workspace, and you can still switch on any screen.</p>
          <form action={setReviewLanguage} className="pm-keyform">
            <label className="pm-field">Default translation
              <select name="lang" defaultValue={current.review_language} className="pm-input">
                <option value="bn">Bengali (বাংলা)</option>
                <option value="en">English</option>
              </select>
            </label>
            <button type="submit" className="pm-btn pm-btn-primary">Save</button>
          </form>
        </section>
      ) : null}
    </AppFrame>
  );
}
