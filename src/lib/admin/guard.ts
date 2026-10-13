import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAdminRole } from "./roles";

/**
 * Server-side admin gate. Call it at the top of every admin page AND every admin server action.
 *  - not signed in            -> /login
 *  - signed in, not an admin  -> 404 (does not reveal that /admin exists)
 *  - admin without 2FA (aal2) -> /admin/mfa  (enrol or enter the authenticator code)
 * `requireMfa: false` is only for the 2FA page itself.
 */
export async function requireAdmin(opts: { requireMfa?: boolean } = {}) {
  const { requireMfa = true } = opts;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=%2Fadmin");

  // Reads the caller's own profile through RLS (profiles_select_own).
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, suspended")
    .eq("user_id", user.id)
    .maybeSingle();

  const role: unknown = profile?.role;
  if (!isAdminRole(role) || profile?.suspended === true) notFound();

  if (requireMfa) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel !== "aal2") redirect("/admin/mfa");
  }

  return { supabase, user, role };
}
