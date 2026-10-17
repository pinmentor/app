import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, masterKeyStatus, SecretsError } from "./crypto";

const KEY = randomBytes(32).toString("base64");
const OTHER = randomBytes(32).toString("base64");

describe("secrets crypto", () => {
  it("round-trips and never contains the plaintext", () => {
    const blob = encryptSecret("anthropic", "sk-ant-api03-SECRETVALUE", KEY);
    expect(blob.startsWith("v1.")).toBe(true);
    expect(blob.includes("SECRETVALUE")).toBe(false);
    expect(decryptSecret("anthropic", blob, KEY)).toBe("sk-ant-api03-SECRETVALUE");
  });

  it("uses a fresh IV every time", () => {
    expect(encryptSecret("openai", "same-key-123456", KEY)).not.toBe(encryptSecret("openai", "same-key-123456", KEY));
  });

  it("handles unicode and long values", () => {
    const v = "ñ".repeat(300);
    expect(decryptSecret("gemini", encryptSecret("gemini", v, KEY), KEY)).toBe(v);
  });

  it("fails with the wrong master key", () => {
    const blob = encryptSecret("openai", "sk-1234567890", KEY);
    expect(() => decryptSecret("openai", blob, OTHER)).toThrow("decrypt_failed");
  });

  it("is bound to the provider: a blob moved to another provider does not decrypt", () => {
    const blob = encryptSecret("openai", "sk-1234567890", KEY);
    expect(() => decryptSecret("anthropic", blob, KEY)).toThrow("decrypt_failed");
  });

  it("detects tampering in any part", () => {
    const parts = encryptSecret("openai", "sk-1234567890", KEY).split(".");
    for (const i of [1, 2, 3]) {
      const t = [...parts];
      const buf = Buffer.from(t[i]!, "base64url");
      buf[0] = (buf[0]! ^ 1) & 0xff;
      t[i] = buf.toString("base64url");
      expect(() => decryptSecret("openai", t.join("."), KEY)).toThrow("decrypt_failed");
    }
  });

  it("rejects malformed blobs", () => {
    expect(() => decryptSecret("openai", "plaintext-key", KEY)).toThrow("bad_blob");
    expect(() => decryptSecret("openai", "v2.a.b.c", KEY)).toThrow("bad_blob");
  });

  it("reports a missing or wrongly sized master key by code, without echoing it", () => {
    expect(() => encryptSecret("openai", "sk-1234567890", undefined)).toThrow("master_key_missing");
    expect(() => encryptSecret("openai", "sk-1234567890", Buffer.alloc(16).toString("base64"))).toThrow("master_key_invalid");
    try {
      encryptSecret("openai", "sk-1234567890", "short-key");
    } catch (e) {
      expect(e instanceof SecretsError).toBe(true);
      expect(String((e as Error).message).includes("short-key")).toBe(false);
    }
    expect(masterKeyStatus(KEY)).toBe("ok");
    expect(masterKeyStatus(undefined)).toBe("missing");
    expect(masterKeyStatus("abc")).toBe("invalid");
  });
});
