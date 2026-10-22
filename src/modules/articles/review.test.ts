import { describe, expect, it } from "vitest";
import { glossParts, glossRowCount, isGlossLang, itemsSchema as gItems, paragraphsSchema } from "./gloss";
import { lightOf, mergeReview, reviewChecks, reviewPrompt, reviewSchema, reviewText, storedReviewSchema, type StoredReview } from "./review";
import type { QaReport } from "./qa";
import type { ArticleParts } from "./render";

const parts: ArticleParts = {
  title: "7 ideas de peinados",
  locale: "es-MX",
  highlights: ["Rápido"],
  intro: { paragraphs: ["Hola uno.", "Hola dos."] },
  items: [{ heading: "Cola", paragraphs: ["Texto cola."], bullets: ["Liga"] }, { heading: "Trenza", paragraphs: ["Texto trenza."], bullets: [] }],
  faq: { items: [{ question: "¿Sirve?", answer: "Sí sirve bastante." }] },
  conclusion: { paragraphs: ["Fin del texto."] },
};
const qa: QaReport = { verdict: "pass", words: 100, checks: [{ id: "items", status: "pass", summary: "ok" }] };

describe("reviewText", () => {
  it("labels every block so the judge can point at it", () => {
    const t = reviewText(parts);
    expect(t).toContain("[title] 7 ideas de peinados");
    expect(t).toContain("[intro 2] Hola dos.");
    expect(t).toContain("[item 1 bullet 1] Liga");
    expect(t).toContain("[item 2 text 1] Texto trenza.");
    expect(t).toContain("[faq 1 answer] Sí sirve bastante.");
    expect(t).toContain("[conclusion 1] Fin del texto.");
  });
  it("prompt asks for English notes and names the variant", () => {
    const p = reviewPrompt("x", "es-MX");
    expect(p.system).toContain("Mexican Spanish");
    expect(p.system).toContain("in English");
  });
});

describe("reviewSchema", () => {
  it("accepts a normal answer", () => {
    const r = reviewSchema.safeParse({ verdict: "minor", issues: [{ where: "intro 1", type: "grammar", excerpt: "x", problem: "p", fix: "f" }], risky_claims: [{ where: "item 1", kind: "health", excerpt: "e", note: "n" }] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.issues[0]?.type).toBe("grammar");
  });
  it("is tolerant: unknown types, missing keys, junk items, no lists", () => {
    const r = reviewSchema.safeParse({ verdict: "MAJOR", issues: [{ type: "weird", problem: "p" }, 5, null] });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.verdict).toBe("major");
      expect(r.data.issues.length).toBe(1);
      expect(r.data.issues[0]?.type).toBe("other");
      expect(r.data.risky_claims).toEqual([]);
    }
  });
  it("caps lists", () => {
    const many = Array.from({ length: 30 }, () => ({ problem: "p" }));
    const r = reviewSchema.safeParse({ verdict: "good", issues: many, risky_claims: many });
    expect(r.success && r.data.issues.length === 12 && r.data.risky_claims.length === 8).toBe(true);
  });
});

describe("checks and light", () => {
  const base: StoredReview = { status: "done", verdict: "good", issues: [], risky_claims: [], cross_model: true };
  it("good and nothing found -> pass; light green", () => {
    const m = mergeReview(qa, base);
    expect(m.verdict).toBe("pass");
    expect(lightOf(m.verdict)).toBe("green");
  });
  it("minor -> flag/yellow; claims -> flag", () => {
    expect(mergeReview(qa, { ...base, verdict: "minor", issues: [{ where: "a", type: "grammar", excerpt: "", problem: "", fix: "" }] }).verdict).toBe("flag");
    const c = reviewChecks({ ...base, risky_claims: [{ where: "a", kind: "health", excerpt: "", note: "" }] });
    expect(c.find((x) => x.id === "risky_claims")?.status).toBe("flag");
    expect(c.find((x) => x.id === "risky_claims")?.summary).toContain("1 health-related");
  });
  it("major -> fail/red; a mechanical fail stays red", () => {
    expect(lightOf(mergeReview(qa, { ...base, verdict: "major" }).verdict)).toBe("red");
    expect(mergeReview({ ...qa, verdict: "fail", checks: [{ id: "price", status: "fail", summary: "x" }] }, base).verdict).toBe("fail");
  });
  it("a skipped review is a yellow flag, never a pass; same-provider is stated", () => {
    const m = mergeReview(qa, { status: "skipped", issues: [], risky_claims: [], reason: "no_route" });
    expect(m.verdict).toBe("flag");
    expect(m.checks.find((x) => x.id === "language_review")?.summary).toContain("no_route");
    expect(reviewChecks({ ...base, cross_model: false })[0]?.summary).toContain("weaker check");
  });
  it("re-merging replaces the old review checks instead of duplicating", () => {
    const once = mergeReview(qa, base);
    const twice = mergeReview(once, { ...base, verdict: "minor", issues: [{ where: "a", type: "other", excerpt: "", problem: "", fix: "" }] });
    expect(twice.checks.filter((x) => x.id === "language_review").length).toBe(1);
  });
  it("stored review round-trips through its schema", () => {
    expect(storedReviewSchema.safeParse(base).success).toBe(true);
    expect(storedReviewSchema.safeParse({}).success).toBe(false);
    expect(lightOf(undefined)).toBe("yellow");
  });
});

describe("gloss", () => {
  it("parts match the SQL (chunks of 6)", () => {
    expect(glossParts(7)).toEqual(["head", "intro", "items:0", "items:6", "faq"]);
    expect(glossParts(6)).toEqual(["head", "intro", "items:0", "faq"]);
    expect(glossParts(1)).toEqual(["head", "intro", "items:0", "faq"]);
    expect(glossRowCount(7)).toBe(11);
  });
  it("languages", () => {
    expect(isGlossLang("bn") && isGlossLang("en") && !isGlossLang("fr")).toBe(true);
  });
  it("schemas keep usable entries", () => {
    expect(paragraphsSchema.safeParse({ paragraphs: ["a", "", 3] }).success).toBe(true);
    expect(paragraphsSchema.safeParse({ paragraphs: [] }).success).toBe(false);
    const r = gItems.safeParse({ results: [{ i: 2, heading: "H", paragraphs: ["p"] }, { i: 3, paragraphs: [] }] });
    expect(r.success && r.data.length === 1 && r.data[0]?.i === 2).toBe(true);
  });
});
