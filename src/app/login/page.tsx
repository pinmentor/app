import { redirect } from "next/navigation";
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
    <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-6 px-4">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Sign in to PinMentor</h1>
        <p className="mt-2 text-sm text-neutral-600">No password needed. We email you a one-time link.</p>
      </div>

      {error && CALLBACK_ERRORS[error] ? <p className="text-sm text-red-600">{CALLBACK_ERRORS[error]}</p> : null}

      {siteKey ? (
        <LoginForm siteKey={siteKey} />
      ) : (
        <p className="text-sm text-red-600">Sign-in is not configured yet (missing TURNSTILE_SITE_KEY).</p>
      )}
    </main>
  );
}
