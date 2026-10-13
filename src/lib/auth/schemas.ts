import { z } from "zod";

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email());

export const loginInputSchema = z.object({
  email: emailSchema,
  captchaToken: z.string().min(1).max(4096),
});

export type LoginInput = z.infer<typeof loginInputSchema>;

/** Token types we accept on /auth/callback (magic-link emails). */
export const callbackOtpTypeSchema = z.enum(["email", "magiclink", "signup"]);

/**
 * Only allow same-site relative paths after login. Anything else (absolute URLs,
 * protocol-relative `//evil.com`, backslash tricks) falls back to the default.
 */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next) return fallback;
  if (!next.startsWith("/")) return fallback;
  if (next.startsWith("//") || next.includes("\\")) return fallback;
  if (/[\u0000-\u001f]/.test(next)) return fallback;
  return next;
}
