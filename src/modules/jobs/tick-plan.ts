/**
 * Decides whether one worker call (a Vercel function, 60 s limit) runs another round of jobs. pg_cron calls the tick
 * once a minute; without a loop every stage hop of a map run waited for the next call. Pure: no I/O, unit-tested.
 *
 * A new round starts only early enough that its handlers still fit inside the function limit.
 */
export const ROUND_START_CUTOFF_MS = 30_000;
export const IDLE_WAIT_MS = 3_000;
export const FUNCTION_LIMIT_MS = 57_000;

export type RoundInput = {
  elapsedMs: number;
  /** jobs claimed by the round that just ended */
  claimedLast: number;
  /** a queued job becomes due before the cutoff (only asked when claimedLast = 0) */
  dueSoon: boolean;
};
export type RoundDecision = { action: "stop" } | { action: "again"; waitMs: number };

export function nextRound(i: RoundInput): RoundDecision {
  if (i.elapsedMs >= ROUND_START_CUTOFF_MS) return { action: "stop" };
  if (i.claimedLast > 0) return { action: "again", waitMs: 0 };
  return i.dueSoon && i.elapsedMs + IDLE_WAIT_MS < ROUND_START_CUTOFF_MS ? { action: "again", waitMs: IDLE_WAIT_MS } : { action: "stop" };
}

/** Handler timeout of a round that starts after `elapsedMs`: never past the function limit, never above 50 s. */
export function handlerTimeoutMs(elapsedMs: number): number {
  return Math.max(5_000, Math.min(50_000, FUNCTION_LIMIT_MS - elapsedMs));
}
