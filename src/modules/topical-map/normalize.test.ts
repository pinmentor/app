import { describe, expect, it } from "vitest";
import { extractFacts, conflict } from "./modifiers";
import { fold, normalize, singularize } from "./normalize";

describe("fold", () => {
  it("strips accents for matching only", () => {
    expect(fold("Peinados Fáciles, ¿Cómo?")).toBe("peinados faciles como");
    expect(fold("niñas")).toBe("ninas");
  });
});

describe("singularize", () => {
  it.each([
    ["peinados", "peinado"],
    ["mujeres", "mujer"],
    ["faciles", "facil"],
    ["bebes", "bebe"],
    ["cortes", "corte"],
    ["rizadores", "rizador"],
    ["scrunchies", "scrunchie"],
  ])("%s -> %s", (a, b) => expect(singularize(a)).toBe(b));
  it("keeps gender: ninas and ninos stay different", () => {
    expect(singularize("ninas")).not.toBe(singularize("ninos"));
  });
});

describe("normalize", () => {
  it("is order, plural, stopword and synonym insensitive", () => {
    expect(normalize("Peinados para pelo rizado").key).toBe(normalize("rizado cabello de peinado").key);
    expect(normalize("peinados fáciles").key).toBe(normalize("peinados sencillos").key);
    expect(normalize("peinados simples").key).toBe(normalize("peinados fáciles").key);
  });
  it("keeps sin (sin plancha != con plancha)", () => {
    expect(normalize("peinados sin plancha").key).not.toBe(normalize("peinados con plancha").key);
  });
  it("maps es-MX regional words only for es-MX", () => {
    expect(normalize("cabello chino", "es-MX").key).toBe(normalize("cabello rizado", "es-MX").key);
    expect(normalize("cabello chino", "es-ES").key).not.toBe(normalize("cabello rizado", "es-ES").key);
  });
  it("rewrites xv/quince años to quinceañera", () => {
    expect(normalize("peinados para xv años").key).toBe(normalize("peinados de quinceañera").key);
  });
});

describe("modifier conflicts", () => {
  const c = (a: string, b: string) => conflict(extractFacts(normalize(a)), extractFacts(normalize(b)));
  it("flags exclusive values", () => {
    expect(c("peinados para niñas", "peinados para niños")).toMatch(/audience/);
    expect(c("cabello corto", "cabello largo")).toMatch(/length/);
    expect(c("peinados fáciles", "peinados elegantes")).toMatch(/vibe/);
  });
  it("flags different numbers of the same kind", () => {
    expect(c("peinados en 5 minutos", "peinados en 10 minutos")).toMatch(/number/);
    expect(c("30 peinados", "50 peinados")).toMatch(/number/);
  });
  it("flags con vs sin on the same noun", () => {
    expect(c("ondas con plancha", "ondas sin plancha")).toMatch(/polarity/);
  });
  it("does not flag a one-sided modifier (that is parent/child, not a conflict)", () => {
    expect(c("peinados fáciles", "peinados fáciles para niñas")).toBeNull();
  });
});
