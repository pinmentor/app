"use server";

import { headers } from "next/headers";
import { loginInputSchema } from "@/lib/auth/schemas";
import { createClient } from "@/lib/supabase/server";

export type LoginState = { status: "idle" | "sent" | "error"; message?: string };

const GENERIC_ERROR = "We could not send the link. Please check the email address and try again.";

async function siteOrigin(): Promise<string> {
  const h = await headers();
  const origin = h.get("origin");
  if (origin) return origin;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host ?? "localhost:3000"}`;
}

/**
 * Sends a magic link. The Turnstile token is forwarded to Supabase Auth, which verifies it
 * server-side (Auth → Bot and Abuse Protection → Turnstile), so calling the Auth API directly
 * without a valid token is rejected too.
 */
export async function requestMagicLink(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginInputSchema.safeParse({
    email: formData.get("email"),
    captchaToken: formData.get("captchaToken"),
  });
  if (!parsed.success) {
    const missingToken = parsed.error.issues.some((i) => i.path[0] === "captchaToken");
    return {
      status: "error",
      message: missingToken ? "Please complete the verification challenge." : "Enter a valid email address.",
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: `${await siteOrigin()}/auth/callback`,
      captchaToken: parsed.data.captchaToken,
    },
  });

  if (error) return { status: "error", message: GENERIC_ERROR };
  return { status: "sent", message: "Check your inbox: we sent you a sign-in link." };
}
