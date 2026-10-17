import { describe, expect, it } from "vitest";
import { expansionPrompt, facetModelSchema, facetPrompt, toCandidates } from "./facets";

describe("facet schema and prompts", () => {
  it("accepts a sane taxonomy and rejects thin or malformed ones", () => {
    const f = (name: string) => ({ name, kind: "other", values: ["a", "b"] });
    expect(facetModelSchema.safeParse({ facets: [f("x"), f("y"), f("z")] }).success).toBe(true);
    expect(facetModelSchema.safeParse({ facets: [f("x")] }).success).toBe(false);
    expect(facetModelSchema.safeParse({ facets: [f("x"), f("y"), { name: "z", kind: "nope", values: ["a", "b"] }] }).success).toBe(false);
  });
  it("prompts carry topic, locale and facet value", () => {
    expect(facetPrompt("Peinados", "es-MX").system).toContain("Mexican Spanish");
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
