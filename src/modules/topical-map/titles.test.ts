import { describe, expect, it } from "vitest";
import { assignListCounts, buildSlugs, cleanTitles, fallbackTitle, seededRandom, stripYears, targetWords, titleProblem, titlePrompt, titleResponseSchema } from "./titles";

describe("list numbers", () => {
  it("are deterministic, inside the range, distinct inside a silo, round numbers last", () => {
    const a = assignListCounts(12, { min: 7, max: 35 }, "run1:silo0");
    expect(a).toEqual(assignListCounts(12, { min: 7, max: 35 }, "run1:silo0"));
    expect(a.every((n) => n >= 7 && n <= 35)).toBe(true);
    expect(new Set(a).size).toBe(12);
    expect(a.some((n) => n % 5 === 0)).toBe(false);
  });
  it("repeats only when the range is exhausted", () => {
    const a = assignListCounts(10, { min: 7, max: 9 }, "s");
    expect(a.length).toBe(10);
    expect(new Set(a).size).toBe(3);
  });
  it("different seeds give different sequences; the generator is in [0,1)", () => {
    expect(assignListCounts(8, { min: 7, max: 35 }, "x").join() === assignListCounts(8, { min: 7, max: 35 }, "y").join()).toBe(false);
    const r = seededRandom("q");
    for (let i = 0; i < 50; i++) {
      const v = r();
      expect(v >= 0 && v < 1).toBe(true);
    }
  });
  it("word targets scale for lists and are fixed for B", () => {
    expect(targetWords("B", null)).toBe(1800);
    expect(targetWords("A", 7)).toBe(1200);
    expect(targetWords("A", 35)).toBe(3000);
  });
});

describe("title validation", () => {
  it("Type A must carry exactly its number", () => {
    expect(titleProblem("Los 27 Mejores Peinados para Cabello Rizado", "A", 27)).toBeNull();
    expect(titleProblem("Los 25 Mejores Peinados para Cabello Rizado", "A", 27)).toBe("missing_list_number");
    expect(titleProblem("Los 27 Peinados en 5 minutos de cabello", "A", 27)).toBe("other_number");
  });
  it("rejects years, prices and numbers in Type B", () => {
    expect(titleProblem("Peinados de moda 2026 para boda", "B", null)).toBe("has_year");
    expect(titleProblem("Planchas de cabello por $500 pesos", "B", null)).toBe("has_price");
    expect(titleProblem("Las 5 mejores planchas de cabello", "B", null)).toBe("has_number");
    expect(titleProblem("Mejores planchas de cabello", "B", null)).toBeNull();
  });
  it("keeps up to 3 distinct good options, else one flagged fallback", () => {
    const ok = cleanTitles(["Los 27 Mejores Peinados", "los 27 mejores peinados", "27 Peinados Faciles para Boda", "Peinados 2026 con 27 ideas"], "A", 27, "peinados", "es-MX");
    expect(ok.fallback).toBe(false);
    expect(ok.options.length).toBe(2);
    const bad = cleanTitles(["x"], "A", 27, "peinados con trenza", "es-MX");
    expect(bad.fallback).toBe(true);
    expect(bad.options).toEqual([fallbackTitle("peinados con trenza", "A", 27, "es-MX")]);
    expect(titleProblem(bad.options[0]!, "A", 27)).toBeNull();
  });
  it("the response schema drops empty titles and tolerates missing glosses", () => {
    const r = titleResponseSchema.parse([{ i: 0, titles: [" a title here ", ""] }]);
    expect(r[0]!.titles).toEqual(["a title here"]);
    expect(r[0]!.title_gloss_bn).toBe("");
  });
});

describe("years never reach a title", () => {
  it("stripYears removes years only", () => {
    expect(stripYears("peinados boda 2026")).toBe("peinados boda");
    expect(stripYears("peinados de los 90")).toBe("peinados de los 90");
    expect(stripYears("2025 peinados  2026")).toBe("peinados");
  });
  it("the fallback title and the prompt carry no year", () => {
    expect(titleProblem(fallbackTitle("peinados boda 2026", "A", 27, "es-MX"), "A", 27)).toBeNull();
    expect(titlePrompt("peinados", "es-MX", [{ keyword: "peinados boda 2026", type: "A", listCount: 27 }]).prompt.includes("2026")).toBe(false);
  });
});

describe("slugs", () => {
  it("are keyword-only, ASCII, kebab-case and never carry a year", () => {
    expect(buildSlugs(["Peinados para niña 2026", "peinados con ñandú"], "es")).toEqual(["peinados-para-nina", "peinados-nandu"]);
  });
  it("stay unique inside the run and respect slugs already taken", () => {
    expect(buildSlugs(["peinados de boda", "Peinados de boda", "peinados de boda"], "es")).toEqual(["peinados-boda", "peinados-boda-2", "peinados-boda-3"]);
    expect(buildSlugs(["peinados de boda"], "es", new Set(["peinados-boda"]))).toEqual(["peinados-boda-2"]);
  });
  it("never returns an empty slug", () => {
    expect(buildSlugs(["2026"], "es")[0]!.length > 0).toBe(true);
  });
});
