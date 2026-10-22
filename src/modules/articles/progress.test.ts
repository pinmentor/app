import { describe, expect, it } from "vitest";
import { progressCounts, runFlash } from "./progress";

describe("progressCounts", () => {
  it("counts each status and the open/done split", () => {
    const c = progressCounts(["queued", "writing", "ready", "ready", "failed", "canceled", "weird"]);
    expect(c).toEqual({ total: 7, queued: 1, writing: 1, ready: 2, failed: 1, canceled: 1, open: 2, done: 5 });
  });
  it("handles an empty list", () => {
    expect(progressCounts([]).open).toBe(0);
  });
});

describe("runFlash", () => {
  it("maps codes", () => {
    expect(runFlash("PM005")).toBe("norate");
    expect(runFlash("PM001")).toBe("credits");
    expect(runFlash("PM003")).toBe("locked");
    expect(runFlash("PM004")).toBe("gone");
    expect(runFlash("42501")).toBe("forbidden");
    expect(runFlash(undefined)).toBe("error");
  });
});
