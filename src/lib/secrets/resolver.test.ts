import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./crypto";
import { createKeyResolver } from "./resolver";

const KEY = randomBytes(32).toString("base64");

function setup(opts: { stored?: Record<string, string>; env?: Record<string, string>; failLookup?: boolean; masterKey?: string | undefined } = {}) {
  let now = 1_000;
  let lookups = 0;
  const mk = "masterKey" in opts ? opts.masterKey : KEY;
  const r = createKeyResolver({
    async fetchCiphertext(p) {
      lookups++;
      if (opts.failLookup) throw new Error("db down");
      return opts.stored?.[p] ?? null;
    },
    env: opts.env ?? {},
    decrypt: (p, b) => decryptSecret(p, b, mk),
    now: () => now,
  });
  return { r, lookups: () => lookups, advance: (ms: number) => (now += ms) };
}

describe("key resolver", () => {
  it("prefers the admin-page key over the env var", async () => {
    const { r } = setup({ stored: { anthropic: encryptSecret("anthropic", "sk-ant-from-admin", KEY) }, env: { ANTHROPIC_API_KEY: "sk-ant-from-env-0000" } });
    expect(await r.resolve("anthropic")).toEqual({ key: "sk-ant-from-admin", source: "admin" });
  });

  it("falls back to env when nothing is stored", async () => {
    const { r } = setup({ env: { OPENAI_API_KEY: "sk-openai-env-0000" } });
    expect(await r.resolve("openai")).toEqual({ key: "sk-openai-env-0000", source: "env" });
  });

  it("returns none when neither exists, and ignores too-short env values", async () => {
    const { r } = setup({ env: { GEMINI_API_KEY: "short" } });
    expect(await r.resolve("gemini")).toEqual({ key: null, source: "none" });
  });

  it("builds the DataForSEO secret from two env vars", async () => {
    const { r } = setup({ env: { DATAFORSEO_LOGIN: "me@x.com", DATAFORSEO_PASSWORD: "pw-123456" } });
    const got = await r.resolve("dataforseo");
    expect(got.source).toBe("env");
    expect(JSON.parse(got.key!)).toEqual({ login: "me@x.com", password: "pw-123456" });
  });

  it("caches for 60 s, then looks again; invalidate clears at once", async () => {
    const { r, lookups, advance } = setup({ env: { OPENAI_API_KEY: "sk-openai-env-0000" } });
    await r.get("openai");
    await r.get("openai");
    expect(lookups()).toBe(1);
    advance(59_000);
    await r.get("openai");
    expect(lookups()).toBe(1);
    advance(2_000);
    await r.get("openai");
    expect(lookups()).toBe(2);
    r.invalidate("openai");
    await r.get("openai");
    expect(lookups()).toBe(3);
  });

  it("a stored key that cannot be decrypted falls back to env and says why", async () => {
    const stored = encryptSecret("anthropic", "sk-ant-from-admin", KEY);
    const { r } = setup({ stored: { anthropic: stored }, env: { ANTHROPIC_API_KEY: "sk-ant-from-env-0000" }, masterKey: randomBytes(32).toString("base64") });
    expect(await r.resolve("anthropic")).toEqual({ key: "sk-ant-from-env-0000", source: "env", problem: "decrypt_failed" });
  });

  it("reports a missing ENCRYPTION_KEY instead of throwing", async () => {
    const stored = encryptSecret("anthropic", "sk-ant-from-admin", KEY);
    const { r } = setup({ stored: { anthropic: stored }, masterKey: undefined });
    expect(await r.resolve("anthropic")).toEqual({ key: null, source: "none", problem: "master_key_missing" });
  });

  it("serves env when the database is unreachable and does not cache that answer", async () => {
    const { r, lookups } = setup({ failLookup: true, env: { OPENAI_API_KEY: "sk-openai-env-0000" } });
    expect(await r.resolve("openai")).toEqual({ key: "sk-openai-env-0000", source: "env", problem: "lookup_failed" });
    await r.resolve("openai");
    expect(lookups()).toBe(2);
  });
});
