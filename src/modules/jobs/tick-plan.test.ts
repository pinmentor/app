import { describe, expect, it } from "vitest";
import { handlerTimeoutMs, nextRound } from "./tick-plan";

describe("worker rounds", () => {
  it("keeps going while jobs are being claimed, and stops late in the call", () => {
    expect(nextRound({ elapsedMs: 5_000, claimedLast: 3, dueSoon: false })).toEqual({ action: "again", waitMs: 0 });
    expect(nextRound({ elapsedMs: 31_000, claimedLast: 3, dueSoon: true })).toEqual({ action: "stop" });
  });
  it("idles only when a job is about to be due", () => {
    expect(nextRound({ elapsedMs: 5_000, claimedLast: 0, dueSoon: false })).toEqual({ action: "stop" });
    expect(nextRound({ elapsedMs: 5_000, claimedLast: 0, dueSoon: true })).toEqual({ action: "again", waitMs: 3_000 });
    expect(nextRound({ elapsedMs: 28_500, claimedLast: 0, dueSoon: true })).toEqual({ action: "stop" });
  });
  it("handler timeouts shrink so a round never outlives the function", () => {
    expect(handlerTimeoutMs(0)).toBe(50_000);
    expect(handlerTimeoutMs(30_000)).toBe(27_000);
    expect(handlerTimeoutMs(56_000)).toBe(5_000);
  });
});
