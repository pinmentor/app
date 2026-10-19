import { describe, expect, it } from "vitest";
import { scoreItem, WEIGHTS } from "./score";

const base = { demandTier: 3, compScore: null, articleType: "A" as const, intent: "informational" as const, pinterestFit: 3, seasonality: 0, siloRole: "supporting" as const };

describe("priority score", () => {
  it("weights sum to 1", () => {
    expect(Math.round(Object.values(WEIGHTS).reduce((a, b) => a + b, 0) * 1000) / 1000).toBe(1);
  });
  it("is higher for more demand, better pinterest fit and the pillar role", () => {
    const low = scoreItem(base).priority;
    expect(scoreItem({ ...base, demandTier: 5 }).priority > low).toBe(true);
    expect(scoreItem({ ...base, pinterestFit: 5 }).priority > low).toBe(true);
    expect(scoreItem({ ...base, siloRole: "pillar" }).priority > low).toBe(true);
  });
  it("Type B and weak competition raise it; unknown competition is neutral and said so", () => {
    expect(scoreItem({ ...base, articleType: "B", intent: "transactional" }).priority > scoreItem(base).priority).toBe(true);
    expect(scoreItem({ ...base, compScore: 10 }).priority > scoreItem({ ...base, compScore: 90 }).priority).toBe(true);
    expect(scoreItem(base).notes.some((n) => n.includes("no SERP data"))).toBe(true);
    expect(scoreItem({ ...base, compScore: 50 }).notes.some((n) => n.includes("no SERP data"))).toBe(false);
  });
  it("stays within 0-100", () => {
    const max = scoreItem({ demandTier: 5, compScore: 0, articleType: "B", intent: "transactional", pinterestFit: 5, seasonality: 2, siloRole: "pillar" }).priority;
    const min = scoreItem({ demandTier: 1, compScore: 100, articleType: "A", intent: "informational", pinterestFit: 1, seasonality: 0, siloRole: "unassigned" }).priority;
    expect(max).toBe(100);
    expect(min >= 0 && min < 20).toBe(true);
  });
});
