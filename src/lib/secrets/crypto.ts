import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SecretProviderId } from "./providers";

/**
 * AES-256-GCM for platform keys stored in `platform_secrets`. The master key is the ENCRYPTION_KEY env var
 * (32 random bytes, base64) and lives only in Vercel. Output: "v1.<iv>.<tag>.<ciphertext>" (base64url).
 * The provider name is authenticated data, so a ciphertext copied onto another provider's row fails to decrypt.
 * Errors carry a short code only; neither the plaintext nor the ciphertext is ever put in a message.
 */
export class SecretsError extends Error {
  constructor(public readonly code: "master_key_missing" | "master_key_invalid" | "bad_blob" | "decrypt_failed") {
    super(code);
    this.name = "SecretsError";
  }
}

const b64u = (b: Buffer) => b.toString("base64url");

function masterKey(raw: string | undefined): Buffer {
  if (!raw) throw new SecretsError("master_key_missing");
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) throw new SecretsError("master_key_invalid");
  return key;
}

const aad = (provider: SecretProviderId) => Buffer.from(`pinmentor:secret:${provider}`);

export function encryptSecret(provider: SecretProviderId, plaintext: string, rawMasterKey = process.env.ENCRYPTION_KEY): string {
  const key = masterKey(rawMasterKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(provider));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1.${b64u(iv)}.${b64u(cipher.getAuthTag())}.${b64u(ct)}`;
}

export function decryptSecret(provider: SecretProviderId, blob: string, rawMasterKey = process.env.ENCRYPTION_KEY): string {
  const key = masterKey(rawMasterKey);
  const parts = blob.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new SecretsError("bad_blob");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1]!, "base64url"));
    decipher.setAAD(aad(provider));
    decipher.setAuthTag(Buffer.from(parts[2]!, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretsError("decrypt_failed");
  }
}

/** True when ENCRYPTION_KEY is present and the right size. Used by the admin page to explain a missing setup. */
export function masterKeyStatus(raw = process.env.ENCRYPTION_KEY): "ok" | "missing" | "invalid" {
  try {
    masterKey(raw);
    return "ok";
  } catch (e) {
    return e instanceof SecretsError && e.code === "master_key_missing" ? "missing" : "invalid";
  }
}
