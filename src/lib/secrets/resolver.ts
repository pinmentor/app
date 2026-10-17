import { SecretsError } from "./crypto";
import { envSecret, SECRET_PROVIDERS, type SecretProviderId } from "./providers";

export type KeySource = "admin" | "env" | "none";
export type Resolved = { key: string | null; source: KeySource; problem?: "decrypt_failed" | "master_key_missing" | "master_key_invalid" | "lookup_failed" };

export type ResolverDeps = {
  fetchCiphertext(provider: SecretProviderId): Promise<string | null>;
  env: Record<string, string | undefined>;
  decrypt(provider: SecretProviderId, blob: string): string;
  now(): number;
};

const TTL_MS = 60_000;

/**
 * Where a platform key comes from: the encrypted row saved in /admin/integrations first, then the Vercel env var.
 * Results are cached per server instance for 60 s; saving or removing a key clears this instance's cache at once,
 * other instances catch up within the TTL. A stored key that cannot be decrypted (ENCRYPTION_KEY changed) falls back
 * to env and reports the problem instead of failing the whole request.
 */
export function createKeyResolver(deps: ResolverDeps) {
  const cache = new Map<SecretProviderId, { at: number; value: Resolved }>();

  async function resolve(provider: SecretProviderId): Promise<Resolved> {
    const hit = cache.get(provider);
    if (hit && deps.now() - hit.at < TTL_MS) return hit.value;

    const def = SECRET_PROVIDERS[provider];
    const fromEnv = envSecret(def, deps.env);
    let value: Resolved;
    try {
      const blob = await deps.fetchCiphertext(provider);
      if (blob) {
        try {
          value = { key: deps.decrypt(provider, blob), source: "admin" };
        } catch (e) {
          const code = e instanceof SecretsError && (e.code === "master_key_missing" || e.code === "master_key_invalid") ? e.code : "decrypt_failed";
          value = fromEnv ? { key: fromEnv, source: "env", problem: code } : { key: null, source: "none", problem: code };
        }
      } else {
        value = fromEnv ? { key: fromEnv, source: "env" } : { key: null, source: "none" };
      }
    } catch {
      // database unreachable: do not cache, serve env if there is one
      return fromEnv ? { key: fromEnv, source: "env", problem: "lookup_failed" } : { key: null, source: "none", problem: "lookup_failed" };
    }
    cache.set(provider, { at: deps.now(), value });
    return value;
  }

  return {
    resolve,
    async get(provider: SecretProviderId): Promise<string | null> {
      return (await resolve(provider)).key;
    },
    invalidate(provider?: SecretProviderId) {
      if (provider) cache.delete(provider);
      else cache.clear();
    },
  };
}
