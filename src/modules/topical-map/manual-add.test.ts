import { describe, expect, it } from "vitest";
import { demandLabel, findMatches, parseAddForm, parseVector, type Existing } from "./manual-add";

const T = { high: 0.92, low: 0.65 };
const ex = (keyword: string, extra: Partial<Existing> = {}): Existing => ({ itemId: "i-" + keyword, keyword, text: keyword, isVariant: false, siloName: "S", vector: null, ...extra });

function form(o: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
}
const U = "11111111-1111-4111-8111-111111111111";

describe("findMatches", () => {
  it("same key in other capitals is same", () => {
    const m = findMatches("Peinados Para Bodas", "es-MX", T, null, [ex("peinados para bodas")]);
    expect(m[0]?.kind).toBe("same");
  });
  it("a keyword that adds a modifier is similar", () => {
    const m = findMatches("peinados para bodas sencillos", "es-MX", T, [1, 0], [ex("peinados para bodas", { vector: [1, 0] })]);
    expect(m[0]?.kind).toBe("similar");
  });
  it("a hard modifier conflict is no match", () => {
    expect(findMatches("peinados para niñas", "es-MX", T, [1, 0], [ex("peinados para niños", { vector: [1, 0] })])).toEqual([]);
  });
  it("unrelated text is no match", () => {
    expect(findMatches("recetas de pastel", "es-MX", T, [1, 0], [ex("peinados para bodas", { vector: [0, 1] })])).toEqual([]);
  });
  it("a variant text is found by the rules", () => {
    const m = findMatches("trenza lateral", "es-MX", T, null, [ex("trenzas", { text: "trenza lateral", isVariant: true })]);
    expect(m[0]?.isVariant).toBe(true);
  });
  it("same comes before similar and the list is capped at 5", () => {
    const many = Array.from({ length: 8 }, (_, i) => ex(`peinados para bodas tipo${i}`, { vector: [1, 0] }));
    const m = findMatches("peinados para bodas", "es-MX", T, [1, 0], [...many, ex("peinados para bodas")]);
    expect(m).toHaveLength(5);
    expect(m[0]?.kind).toBe("same");
  });
});

describe("parseVector", () => {
  it("parses pgvector text and arrays, refuses junk", () => {
    expect(parseVector("[0.1,0.2,3]")).toEqual([0.1, 0.2, 3]);
    expect(parseVector([1, 2])).toEqual([1, 2]);
    expect(parseVector("0.1,0.2")).toBeNull();
    expect(parseVector("[a,b]")).toBeNull();
    expect(parseVector(null)).toBeNull();
  });
});

describe("demandLabel", () => {
  it("labels an estimate as an estimate, never as a volume", () => {
    expect(demandLabel({ demand_tier: 4, demand_source: "estimate", volume: null })).toBe("estimate | high");
    expect(demandLabel({ demand_tier: 4, demand_source: "estimate", volume: 5000 })).toBe("estimate | high");
  });
  it("shows a provider number", () => {
    expect(demandLabel({ demand_tier: 3, demand_source: "provider", volume: 12000 })).toBe("provider | 12,000/mo");
  });
  it("is empty when nothing is known", () => {
    expect(demandLabel({ demand_tier: null, demand_source: null, volume: null })).toBe("");
  });
});

describe("parseAddForm", () => {
  it("accepts a check and defaults", () => {
    const f = parseAddForm(form({ run: U, silo: U, text: "  nuevo tema " }));
    expect(f?.intent).toBe("check");
    expect(f?.text).toBe("nuevo tema");
    expect(f?.force).toBe(false);
  });
  it("force and variant intents", () => {
    expect(parseAddForm(form({ run: U, silo: U, text: "x y", intent: "force" }))?.force).toBe(true);
    expect(parseAddForm(form({ run: U, silo: U, text: "x y", intent: "variant", variant_of: U }))?.variantOf).toBe(U);
    expect(parseAddForm(form({ run: U, silo: U, text: "x y", intent: "variant" }))).toBeNull();
  });
  it("refuses empty, too long, too many words, bad ids", () => {
    expect(parseAddForm(form({ run: U, silo: U, text: "  " }))).toBeNull();
    expect(parseAddForm(form({ run: U, silo: U, text: "x".repeat(201) }))).toBeNull();
    expect(parseAddForm(form({ run: U, silo: U, text: "a b c d e f g h i j k l m" }))).toBeNull();
    expect(parseAddForm(form({ run: "nope", silo: U, text: "x" }))).toBeNull();
  });
});
