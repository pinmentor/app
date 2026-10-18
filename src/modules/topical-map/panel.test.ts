import { describe, expect, it } from "vitest";
import { reconcile, samplePairs, splitFor } from "./panel";

describe("panel reconciliation", () => {
  it("agreement is the label", () => {
    expect(reconcile("same", "same")).toEqual({ label: "same", basis: "panel_agree" });
  });
  it("disagreement goes to SERP overlap, else stays uncertain", () => {
    expect(reconcile("same", "related", { common: 5 })).toEqual({ label: "same", basis: "serp" });
    expect(reconcile("same", "related", { common: 0 })).toEqual({ label: "different", basis: "serp" });
    expect(reconcile("same", "related", { common: 2 }).label).toBe("uncertain");
    expect(reconcile("same", "different", null).label).toBe("uncertain");
  });
});

describe("pool sampling and split", () => {
  const pool = Array.from({ length: 100 }, (_, i) => ({ a: `a${i}`, b: `b${i}`, cosine: i / 100 }));
  it("spans the whole cosine range and is reproducible", () => {
    const s = samplePairs(pool, 10);
    expect(s.length).toBe(10);
    expect(s[0]!.cosine > 0.9).toBe(true);
    expect(s[9]!.cosine < 0.15).toBe(true);
    expect(samplePairs(pool, 10)).toEqual(s);
    expect(samplePairs(pool.slice(0, 5), 10).length).toBe(5);
  });
  it("split is stable per pair and roughly 70/30", () => {
    expect(splitFor("x", "y")).toBe(splitFor("x", "y"));
    const dev = pool.filter((p) => splitFor(p.a, p.b) === "dev").length;
    expect(dev > 50 && dev < 90).toBe(true);
  });
});
