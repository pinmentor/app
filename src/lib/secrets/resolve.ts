import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptSecret } from "./crypto";
import type { SecretProviderId } from "./providers";
import { createKeyResolver } from "./resolver";

export type { KeySource, Resolved } from "./resolver";

const ciphertextSchema = z.string().nullable();

export const keyResolver = createKeyResolver({
  async fetchCiphertext(provider) {
    const { data, error } = await createAdminClient().rpc("secret_get_ciphertext", { p_provider: provider });
    if (error) throw new Error("secret_lookup_failed");
    return ciphertextSchema.parse(data ?? null);
  },
  env: process.env,
  decrypt: (p, b) => decryptSecret(p, b),
  now: () => Date.now(),
});

export const getProviderKey = (provider: SecretProviderId) => keyResolver.get(provider);
