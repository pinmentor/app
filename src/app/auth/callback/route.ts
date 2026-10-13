import { NextResponse, type NextRequest } from "next/server";
import { callbackOtpTypeSchema, safeNextPath } from "@/lib/auth/schemas";
import { createClient } from "@/lib/supabase/server";

/**
 * Magic-link landing route. Supports both flows:
 *  - PKCE:        ?code=...                 (default for server-initiated sign-in; must be opened in the same browser)
 *  - token hash:  ?token_hash=...&type=...  (if the email template is customised to link here directly)
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const next = safeNextPath(searchParams.get("next"));
  const fail = () => NextResponse.redirect(new URL("/login?error=callback", origin));

  const supabase = await createClient();

  const code = searchParams.get("code");
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    return error ? fail() : NextResponse.redirect(new URL(next, origin));
  }

  const tokenHash = searchParams.get("token_hash");
  const type = callbackOtpTypeSchema.safeParse(searchParams.get("type"));
  if (tokenHash && type.success) {
    const { error } = await supabase.auth.verifyOtp({ type: type.data, token_hash: tokenHash });
    return error ? fail() : NextResponse.redirect(new URL(next, origin));
  }

  return fail();
}
