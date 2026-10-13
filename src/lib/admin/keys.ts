/** Fresh idempotency key for one rendered admin form. A stale tab resubmitting the same key is a no-op. */
export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}
