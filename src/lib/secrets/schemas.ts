import { z } from "zod";
import { SECRET_PROVIDER_IDS, SECRET_PROVIDERS, type SecretProviderId } from "./providers";

const providerSchema = z.enum(SECRET_PROVIDER_IDS);

/** One API key as pasted: printable ASCII, no spaces or line breaks (the usual copy/paste mistakes). */
const apiKey = z.string().trim().min(10).max(400).regex(/^[\x21-\x7e]+$/, "no_spaces");
const login = z.string().trim().min(3).max(120).regex(/^[\x21-\x7e]+$/, "no_spaces");
const password = z.string().trim().min(6).max(200).regex(/^[\x21-\x7e]+$/, "no_spaces");

export type ParsedSecret = { provider: SecretProviderId; secret: string; last4: string };

/** Turns the posted form into the secret to encrypt, or null when invalid. The returned `last4` is all the UI will ever show. */
export function parseSecretForm(input: Record<string, unknown>): ParsedSecret | null {
  const provider = providerSchema.safeParse(input.provider);
  if (!provider.success) return null;
  const def = SECRET_PROVIDERS[provider.data];
  if (def.kind === "single") {
    const k = apiKey.safeParse(input.key);
    return k.success ? { provider: provider.data, secret: k.data, last4: k.data.slice(-4) } : null;
  }
  const l = login.safeParse(input.login);
  const p = password.safeParse(input.password);
  return l.success && p.success
    ? { provider: provider.data, secret: JSON.stringify({ login: l.data, password: p.data }), last4: p.data.slice(-4) }
    : null;
}

export const providerOnlySchema = z.object({ provider: providerSchema });

export const secretRowSchema = z.object({
  provider: providerSchema,
  last4: z.string(),
  set_at: z.string(),
  set_by_email: z.string().nullable(),
  last_tested_at: z.string().nullable(),
  last_test_ok: z.boolean().nullable(),
  last_test_code: z.string().nullable(),
});
export type SecretRow = z.infer<typeof secretRowSchema>;
