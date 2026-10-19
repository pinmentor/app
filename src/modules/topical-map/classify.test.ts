import { describe, expect, it } from "vitest";
import { articleTypeFor, classificationFlags, classifyResponseSchema, cleanClassification, mentionsPrice, ruleIntent } from "./classify";

const clean = (o: Record<string, unknown>) => cleanClassification(classifyResponseSchema.parse([{ i: 0, ...o }])[0]!);

describe("classification cleaning", () => {
  it("accepts a good answer unchanged", () => {
    const c = clean({ intent: "commercial_investigation", funnel: "consideration", demand: 4, pinterest_fit: 5, seasonality: 1 });
    expect(c).toEqual({ intent: "commercial_investigation", funnel: "consideration", demandTier: 4, pinterestFit: 5, seasonality: 1, mixed: false, unknownLabel: false });
  });
  it("cleans odd labels and out-of-range numbers instead of rejecting", () => {
    const c = clean({ intent: "Commercial Investigation", funnel: "bofu", demand: 99, pinterest_fit: "x", seasonality: -4 });
    expect(c.intent).toBe("commercial_investigation");
    expect(c.funnel).toBe("awareness");
    expect(c.demandTier).toBe(5);
    expect(c.pinterestFit).toBe(3);
    expect(c.seasonality).toBe(0);
  });
  it("an unknown intent becomes informational and is marked", () => {
    const c = clean({ intent: "browsing" });
    expect(c.intent).toBe("informational");
    expect(c.unknownLabel).toBe(true);
  });
});

describe("type and flags", () => {
  it("commercial -> B, everything else -> A", () => {
    expect(articleTypeFor("transactional")).toBe("B");
    expect(articleTypeFor("commercial_investigation")).toBe("B");
    expect(articleTypeFor("informational")).toBe("A");
    expect(articleTypeFor("navigational")).toBe("A");
  });
  it("rules only flag, they never decide", () => {
    expect(ruleIntent("comprar plancha de cabello")).toBe("transactional");
    expect(ruleIntent("peinados para boda")).toBeNull();
    const c = clean({ intent: "informational" });
    expect(classificationFlags("comprar plancha", c)).toContain("mixed_intent");
    expect(classificationFlags("peinados para boda", c)).toEqual([]);
  });
  it("price words are flagged (articles never show prices)", () => {
    expect(mentionsPrice("plancha barata")).toBe(true);
    expect(mentionsPrice("cuánto cuesta un tinte")).toBe(true);
    expect(classificationFlags("plancha barata", clean({ intent: "transactional" }))).toContain("price_words");
  });
});
