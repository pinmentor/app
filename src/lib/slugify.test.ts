import { describe, expect, it } from "vitest";
import { slugify } from "./slugify";

describe("slugify", () => {
  const cases: [string, string, "es" | "en"][] = [
    ["Peinados Fáciles 2026 para Niñas", "peinados-faciles-para-ninas", "es"],
    ["Peinados Fáciles para Niñas", "peinados-faciles-para-ninas", "es"],
    ["Los 27 Mejores Peinados de 2025", "27-mejores-peinados", "es"],
    ["Cómo hacer una trenza francesa", "como-hacer-trenza-francesa", "es"],
    ["Peinados con Trenzas y Moños", "peinados-trenzas-monos", "es"],
    ["  Espacios   múltiples  ", "espacios-multiples", "es"],
    ["¿Qué peinado va con cara redonda?", "peinado-va-cara-redonda", "es"],
    ["Peinados 2024 2025 2026", "peinados", "es"],
    ["Año 2026", "ano", "es"],
    ["Mejores ideas (2027)", "mejores-ideas", "es"],
    ["Cabello rizado: guía completa", "cabello-rizado-guia-completa", "es"],
    ["Peinados para bodas & fiestas", "peinados-para-bodas-fiestas", "es"],
    ["MAYÚSCULAS ÁÉÍÓÚ ÜBER", "mayusculas-aeiou-uber", "es"],
    ["Piña, ñandú, cigüeña", "pina-nandu-ciguena", "es"],
    ["peinados-ya-con-guion", "peinados-ya-guion", "es"],
    ["The 27 Best Morning Recipes of 2026", "27-best-morning-recipes", "en"],
    ["How to Style Curly Hair at Home", "how-style-curly-hair-home", "en"],
    ["Top 10 Hairstyles & Updos", "top-10-hairstyles-updos", "en"],
    ["It's a Beautiful Day", "s-beautiful-day", "en"],
    ["Best Protein Balls 2025 Edition", "best-protein-balls-edition", "en"],
    ["1999 hairstyles", "hairstyles", "en"],
    ["Straße Café", "strasse-cafe", "en"],
    ["Peinado 12345", "peinado-12345", "es"],
    ["Peinado 2026a", "peinado-2026a", "es"],
    ["Hairstyles 20260", "hairstyles-20260", "en"],
    ["el la los", "el-la-los", "es"],
    ["2026", "", "es"],
    ["", "", "es"],
    ["!!!", "", "es"],
    ["---uno---dos---", "uno-dos", "es"],
  ];
  it.each(cases)("%s → %s", (input, expected, lang) => {
    expect(slugify(input, { lang })).toBe(expected);
  });

  it("never contains a 19xx/20xx token", () => {
    for (const [input, , lang] of cases) {
      expect(slugify(input, { lang })).not.toMatch(/(^|-)(19|20)\d{2}(-|$)/);
    }
  });

  it("respects maxLength and cuts on a word boundary", () => {
    const s = slugify("peinados faciles rapidos elegantes para fiestas de noche largas", { maxLength: 30 });
    expect(s.length).toBeLessThanOrEqual(30);
    expect(s.endsWith("-")).toBe(false);
  });

  it("keeps stopwords when removeStopwords is false", () => {
    expect(slugify("los peinados de la abuela", { removeStopwords: false })).toBe("los-peinados-de-la-abuela");
  });
});
