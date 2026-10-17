import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SECRET_PROVIDER_IDS } from "./providers";
import { parseSecretForm } from "./schemas";
import { testProviderKey } from "./test-connection";

const respond = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch;

describe("testProviderKey", () => {
  it("ok on 2xx, http_<status> otherwise", async () => {
    expect(await testProviderKey("openai", "sk-1234567890", respond(200))).toEqual({ ok: true, code: "ok" });
    expect(await testProviderKey("openai", "sk-1234567890", respond(401))).toEqual({ ok: false, code: "http_401" });
    expect(await testProviderKey("anthropic", "sk-1234567890", respond(429))).toEqual({ ok: false, code: "http_429" });
  });

  it("maps network failures and timeouts to short codes", async () => {
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const slow = (async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }) as unknown as typeof fetch;
    expect(await testProviderKey("gemini", "AIza1234567890", down)).toEqual({ ok: false, code: "network_error" });
    expect(await testProviderKey("gemini", "AIza1234567890", slow)).toEqual({ ok: false, code: "timeout" });
  });

  it("sends the key in a header, never in the URL, and only reads", async () => {
    const seen: { url: string; method: string; headers: Record<string, string> }[] = [];
    const spy = (async (url: string, init: RequestInit) => {
      seen.push({ url, method: String(init.method), headers: init.headers as Record<string, string> });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await testProviderKey("gemini", "AIzaSECRET123456", spy);
    await testProviderKey("anthropic", "sk-ant-SECRET123456", spy);
    await testProviderKey("openai", "sk-SECRET123456", spy);
    await testProviderKey("dataforseo", JSON.stringify({ login: "me@x.com", password: "PWSECRET1" }), spy);
    for (const s of seen) {
      expect(s.method).toBe("GET");
      expect(s.url.includes("SECRET")).toBe(false);
    }
    expect(seen[0]!.headers["x-goog-api-key"]).toBe("AIzaSECRET123456");
    expect(seen[1]!.headers["x-api-key"]).toBe("sk-ant-SECRET123456");
    expect(seen[2]!.headers.Authorization).toBe("Bearer sk-SECRET123456");
    expect(seen[3]!.headers.Authorization).toBe(`Basic ${Buffer.from("me@x.com:PWSECRET1").toString("base64")}`);
  });

  it("refuses a malformed DataForSEO secret without calling out", async () => {
    let called = false;
    const f = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
    expect(await testProviderKey("dataforseo", "not-json", f)).toEqual({ ok: false, code: "bad_secret" });
    expect(called).toBe(false);
  });
});

describe("parseSecretForm", () => {
  it("accepts a clean key and exposes only the last 4 characters", () => {
    expect(parseSecretForm({ provider: "anthropic", key: "  sk-ant-api03-abcdefWXYZ  " })).toEqual({
      provider: "anthropic",
      secret: "sk-ant-api03-abcdefWXYZ",
      last4: "WXYZ",
    });
  });

  it("rejects pasted junk: spaces, line breaks, quotes-with-spaces, too short, unknown provider", () => {
    expect(parseSecretForm({ provider: "openai", key: "sk-abc def-1234567" })).toBeNull();
    expect(parseSecretForm({ provider: "openai", key: "sk-abc\ndef-1234567" })).toBeNull();
    expect(parseSecretForm({ provider: "openai", key: "short" })).toBeNull();
    expect(parseSecretForm({ provider: "acme", key: "sk-1234567890" })).toBeNull();
    expect(parseSecretForm({ provider: "openai" })).toBeNull();
  });

  it("DataForSEO needs login and password and stores them together", () => {
    const ok = parseSecretForm({ provider: "dataforseo", login: "me@example.com", password: "p4ssw0rd-abcd" })!;
    expect(JSON.parse(ok.secret)).toEqual({ login: "me@example.com", password: "p4ssw0rd-abcd" });
    expect(ok.last4).toBe("abcd");
    expect(parseSecretForm({ provider: "dataforseo", login: "me@example.com" })).toBeNull();
    expect(parseSecretForm({ provider: "dataforseo", key: "sk-1234567890" })).toBeNull();
  });
});

describe("migration 0007 stays in sync with the app", () => {
  it("allows exactly the providers the app knows", () => {
    const sql = readFileSync(join(__dirname, "../../../supabase/migrations/0007_platform_secrets.sql"), "utf8");
    const m = sql.match(/provider in \(([^)]*)\)/);
    const inSql = [...(m?.[1] ?? "").matchAll(/'([a-z]+)'/g)].map((x) => x[1]).sort();
    expect(inSql).toEqual([...SECRET_PROVIDER_IDS].sort());
  });
});
