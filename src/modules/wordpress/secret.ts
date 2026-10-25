import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { SecretsError } from "@/lib/secrets/crypto";

/**
 * Application Password of a WordPress site: AES-256-GCM with the same master key (ENCRYPTION_KEY) and the same blob format as
 * platform secrets ("v1.<iv>.<tag>.<ciphertext>"). The authenticated data is workspace + address, so a ciphertext copied onto another
 * site or workspace fails to decrypt. The password is never logged, returned to the browser or put in an error.
 */
const aad = (workspaceId: string, baseUrl: string) => Buffer.from(`pinmentor:site:${workspaceId}:${baseUrl}`);
const b64u = (b: Buffer) => b.toString("base64url");

function masterKey(raw: string | undefined): Buffer {
  if (!raw) throw new SecretsError("master_key_missing");
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) throw new SecretsError("master_key_invalid");
  return key;
}

export function encryptSitePassword(workspaceId: string, baseUrl: string, plaintext: string, rawKey = process.env.ENCRYPTION_KEY): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", masterKey(rawKey), iv);
  c.setAAD(aad(workspaceId, baseUrl));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return `v1.${b64u(iv)}.${b64u(c.getAuthTag())}.${b64u(ct)}`;
}

export function decryptSitePassword(workspaceId: string, baseUrl: string, blob: string, rawKey = process.env.ENCRYPTION_KEY): string {
  const key = masterKey(rawKey);
  const p = blob.split(".");
  if (p.length !== 4 || p[0] !== "v1") throw new SecretsError("bad_blob");
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(p[1]!, "base64url"));
    d.setAAD(aad(workspaceId, baseUrl));
    d.setAuthTag(Buffer.from(p[2]!, "base64url"));
    return Buffer.concat([d.update(Buffer.from(p[3]!, "base64url")), d.final()]).toString("utf8");
  } catch {
    throw new SecretsError("decrypt_failed");
  }
}

/** WordPress shows Application Passwords in groups ("abcd efgh ..."); spaces are not part of the secret. */
export const cleanAppPassword = (s: string) => s.replace(/\s+/g, "");
