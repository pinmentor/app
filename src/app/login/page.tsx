import { redirect } from "next/navigation";
import { Logo } from "@/components/brand";
import { safeNextPath } from "@/lib/auth/schemas";
import { createClient } from "@/lib/supabase/server";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in — PinMentor" };

const CALLBACK_ERRORS: Record<string, string> = {
  callback: "That sign-in link is invalid or has expired. Request a new one.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect(safeNextPath(next));

  // Server-side read: the site key is public by design, but this avoids needing a NEXT_PUBLIC_ twin variable.
  const siteKey = process.env.TURNSTILE_SITE_KEY ?? "";

  return (
    <div className="pm-auth">
      <aside className="pm-auth-aside">
        <Logo />
        <p className="pm-auth-line">Map the topic. Publish the posts. Pin them.</p>
        <div className="pm-pins" aria-hidden="true">
          <div className="pm-pin pm-pin-a">
            <i />
            <i />
          </div>
          <div className="pm-pin pm-pin-b">
            <i />
            <i />
          </div>
          <div className="pm-pin pm-pin-c">
            <i />
            <i />
          </div>
        </div>
      </aside>

      <main className="pm-auth-main">
        <div className="pm-auth-card">
          <div>
            <h1>Sign in</h1>
            <p className="pm-muted">No password needed. We email you a one-time link.</p>
          </div>

          {error && CALLBACK_ERRORS[error] ? <p className="pm-note pm-note-bad">{CALLBACK_ERRORS[error]}</p> : null}

          {siteKey ? (
            <LoginForm siteKey={siteKey} />
          ) : (
            <p className="pm-note pm-note-bad">Sign-in is not configured yet (missing TURNSTILE_SITE_KEY).</p>
          )}
        </div>
      </main>
    </div>
  );
}
