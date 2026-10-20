import { describe, expect, it } from "vitest";
import { formatSeconds, stageDurations, totalSeconds } from "./timeline";

const T0 = "2026-10-20T10:00:00.000Z";

describe("stage timeline", () => {
  it("the first stage runs from creation; each stage lasts until the next starts; the last until the run finished", () => {
    const tl = [
      { stage: "s2_expand", at: "2026-10-20T10:01:30.000Z" },
      { stage: "s3_normalize", at: "2026-10-20T10:02:00.000Z" },
    ];
    expect(stageDurations(T0, tl, "2026-10-20T10:05:00.000Z")).toEqual([
      { stage: "s1_facets", seconds: 90 },
      { stage: "s2_expand", seconds: 30 },
      { stage: "s3_normalize", seconds: 180 },
    ]);
  });
  it("a running run has an open last stage; junk is ignored", () => {
    expect(stageDurations(T0, [{ stage: "s2_expand", at: "2026-10-20T10:00:10.000Z" }], null)).toEqual([{ stage: "s1_facets", seconds: 10 }, { stage: "s2_expand", seconds: null }]);
    expect(stageDurations(T0, "nope", "2026-10-20T10:00:20.000Z")).toEqual([{ stage: "s1_facets", seconds: 20 }]);
  });
  it("formats and totals", () => {
    expect(formatSeconds(75)).toBe("1:15");
    expect(formatSeconds(5)).toBe("0:05");
    expect(formatSeconds(null)).toBe("running");
    expect(totalSeconds(T0, "2026-10-20T10:03:07.000Z")).toBe(187);
    expect(totalSeconds(T0, null)).toBeNull();
  });
});
