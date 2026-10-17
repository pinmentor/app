import { parseLoginPassword, type SecretProviderId } from "./providers";

export type TestResult = { ok: boolean; /** short code only: "ok", "http_401", "timeout", "network_error", "bad_secret" */ code: string };

/**
 * "Test connection" calls a free, read-only endpoint (a model list or the account page), never a paid generation.
 * It proves the key is accepted; it does not prove the account has credit. NOT yet verified against the live APIs
 * (no keys in the build sandbox): press Test once per provider after adding a key.
 */
export async function testProviderKey(
  provider: SecretProviderId,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TestResult> {
  let url: string;
  let headers: Record<string, string>;
  switch (provider) {
    case "anthropic":
      url = "https://api.anthropic.com/v1/models?limit=1";
      headers = { "x-api-key": secret, "anthropic-version": "2023-06-01" };
      break;
    case "openai":
      url = "https://api.openai.com/v1/models";
      headers = { Authorization: `Bearer ${secret}` };
      break;
    case "gemini":
      url = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1";
      headers = { "x-goog-api-key": secret };
      break;
    case "dataforseo": {
      const lp = parseLoginPassword(secret);
      if (!lp) return { ok: false, code: "bad_secret" };
      url = "https://api.dataforseo.com/v3/appendix/user_data";
      headers = { Authorization: `Basic ${Buffer.from(`${lp.login}:${lp.password}`).toString("base64")}` };
      break;
    }
  }

  try {
    const res = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(15_000), cache: "no-store" });
    return res.ok ? { ok: true, code: "ok" } : { ok: false, code: `http_${res.status}` };
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, code: timeout ? "timeout" : "network_error" };
  }
}
