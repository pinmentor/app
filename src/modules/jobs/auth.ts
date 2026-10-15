import { createHash, timingSafeEqual } from "node:crypto";

const MIN_SECRET_LENGTH = 16;

/**
 * Checks `Authorization: Bearer <CRON_SECRET>` for /api/jobs/tick (called by pg_cron/pg_net or Vercel cron).
 * Fails closed: a missing or short secret authorises nobody. Constant-time comparison.
 */
export function isCronAuthorized(authorizationHeader: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < MIN_SECRET_LENGTH) return false;
  if (!authorizationHeader) return false;

  const match = /^Bearer (.+)$/.exec(authorizationHeader);
  const presented = match?.[1];
  if (!presented) return false;

  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}
