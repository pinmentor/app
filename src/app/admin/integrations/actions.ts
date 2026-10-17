"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin/guard";
import { canManageSecrets } from "@/lib/admin/roles";
import { decryptSecret, encryptSecret, SecretsError } from "@/lib/secrets/crypto";
import { providerOnlySchema, parseSecretForm } from "@/lib/secrets/schemas";
import { keyResolver } from "@/lib/secrets/resolve";
import { testProviderKey } from "@/lib/secrets/test-connection";
import { createAdminClient } from "@/lib/supabase/admin";
import { z } from "zod";

const BASE = "/admin/integrations";

async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null;
}

/** Only short, known codes ever go into the redirect URL. Never the key, never a provider message. */
const go = (flash: string, provider?: string, code?: string): never => {
  const q = new URLSearchParams({ flash });
  if (provider) q.set("p", provider);
  if (code && /^[a-z0-9_.-]{1,40}$/.test(code)) q.set("code", code);
  redirect(`${BASE}?${q.toString()}`);
};

/** Encrypt in the app, then store only the ciphertext. The posted key is never logged or returned. */
export async function saveKey(formData: FormData) {
  const { user, role } = await requireAdmin();
  if (!canManageSecrets(role)) return go("forbidden");

  const parsed = parseSecretForm(Object.fromEntries(formData));
  const providerOnly = providerOnlySchema.safeParse({ provider: formData.get("provider") });
  if (!parsed) return go("invalid", providerOnly.success ? providerOnly.data.provider : undefined);

  let blob: string;
  try {
    blob = encryptSecret(parsed.provider, parsed.secret);
    // prove the round trip before storing: a key we cannot read back must never replace a working one
    if (decryptSecret(parsed.provider, blob) !== parsed.secret) return go("error", parsed.provider);
  } catch (e) {
    return go(e instanceof SecretsError && e.code === "master_key_missing" ? "no_master_key" : "bad_master_key", parsed.provider);
  }

  const { error } = await createAdminClient().rpc("admin_secret_set", {
    p_admin: user.id,
    p_provider: parsed.provider,
    p_ciphertext: blob,
    p_last4: parsed.last4,
    p_ip: await clientIp(),
  });
  if (error) {
    console.error("admin_secret_set failed", error.code ?? "no_code");
    return go(error.code === "42501" ? "forbidden" : "error", parsed.provider);
  }
  keyResolver.invalidate(parsed.provider);
  revalidatePath(BASE);
  return go("saved", parsed.provider);
}

/** Calls a free read-only endpoint with the stored key and records pass/fail (no key material in the record). */
export async function testKey(formData: FormData) {
  const { user, role } = await requireAdmin();
  if (!canManageSecrets(role)) return go("forbidden");
  const p = providerOnlySchema.safeParse({ provider: formData.get("provider") });
  if (!p.success) return go("invalid");

  keyResolver.invalidate(p.data.provider);
  const resolved = await keyResolver.resolve(p.data.provider);
  if (!resolved.key) return go(resolved.problem === "decrypt_failed" || resolved.problem?.startsWith("master_key") ? "cannot_decrypt" : "not_set", p.data.provider);

  const result = await testProviderKey(p.data.provider, resolved.key);
  // Only a key stored in the admin page has a row to record on; an env-var key is still tested and reported.
  const { error } = await createAdminClient().rpc("admin_secret_record_test", {
    p_admin: user.id,
    p_provider: p.data.provider,
    p_ok: result.ok,
    p_code: result.code,
    p_ip: await clientIp(),
  });
  if (error) console.error("admin_secret_record_test failed", error.code ?? "no_code");
  revalidatePath(BASE);
  return go(result.ok ? "test_ok" : "test_failed", p.data.provider, result.code);
}

export async function removeKey(formData: FormData) {
  const { user, role } = await requireAdmin();
  if (!canManageSecrets(role)) return go("forbidden");
  const p = providerOnlySchema.safeParse({ provider: formData.get("provider") });
  if (!p.success) return go("invalid");

  const { data, error } = await createAdminClient().rpc("admin_secret_delete", {
    p_admin: user.id,
    p_provider: p.data.provider,
    p_ip: await clientIp(),
  });
  if (error) {
    console.error("admin_secret_delete failed", error.code ?? "no_code");
    return go(error.code === "42501" ? "forbidden" : "error", p.data.provider);
  }
  keyResolver.invalidate(p.data.provider);
  revalidatePath(BASE);
  return go(z.boolean().safeParse(data).data === false ? "nothing_to_remove" : "removed", p.data.provider);
}
