import { describe, expect, it } from "vitest";
import { expansionPrompt, facetModelSchema, facetPrompt, keywordListSchema, toCandidates } from "./facets";

describe("facet schema and prompts", () => {
  it("accepts a sane taxonomy and rejects thin or malformed ones", () => {
    const f = (name: string) => ({ name, kind: "other", values: ["a", "b"] });
    expect(facetModelSchema.safeParse({ facets: [f("x"), f("y"), f("z")] }).success).toBe(true);
    expect(facetModelSchema.safeParse({ facets: [f("x")] }).success).toBe(false);
    expect(facetModelSchema.safeParse({ facets: "nope" }).success).toBe(false);
    expect(facetModelSchema.safeParse({ facets: [f("x"), f("y"), { name: "z", kind: "other", values: ["only-one"] }] }).success).toBe(false);
  });
  it("cleans harmless deviations instead of rejecting the whole answer", () => {
    const r = facetModelSchema.safeParse({
      facets: [
        { name: " hair length ", kind: "hair_length", values: ["corto", "largo", "corto", "", "x".repeat(80)] },
        { name: "y", kind: "style", values: ["a", "b"] },
        { name: "z", kind: "tool", values: ["a", "b"] },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.facets[0]).toEqual({ name: "hair length", kind: "other", values: ["corto", "largo"] });
      expect(r.data.facets[1]?.kind).toBe("style");
    }
  });
  it("keyword lists drop odd entries but keep the rest", () => {
    const r = keywordListSchema.safeParse({ keywords: ["peinados fáciles", "", " a ", "x".repeat(200), "  boda  "] });
    expect(r.success && r.data.keywords).toEqual(["peinados fáciles", "boda"]);
  });
  it("prompts carry topic, locale and facet value", () => {
    expect(facetPrompt("Peinados", "es-MX").system).toContain("Mexican Spanish");
    expect(facetPrompt("Peinados", "es-MX").prompt).toContain("8-14 facets");
    expect(facetPrompt("Peinados", "es-MX", true).prompt).toContain("how BROAD the topic is");
    expect(expansionPrompt("Peinados", "es-MX", "occasion", "boda").prompt).toContain("occasion = boda");
  });
});

describe("toCandidates", () => {
  it("trims, strips list markers, drops empties, excluded terms, overlong and repeated phrases", () => {
    const out = toCandidates(["  1. peinados fáciles ", "Peinados Fáciles", "", "peinados marca-x", "uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece"], {
      source: "matrix",
      facet: "vibe",
      exclude: ["marca-x"],
    });
    expect(out.map((c) => c.raw)).toEqual(["peinados fáciles"]);
    expect(out[0]).toMatchObject({ source: "matrix", facet: "vibe" });
  });
});
