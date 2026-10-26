import { describe, expect, it } from "vitest";
import { checkPins, pinPrompt, pinSchema, similarity, type PinDraft } from "./copy";

const pin = (o: Partial<PinDraft> = {}): PinDraft => ({
  angle: "quick tip",
  title: "Peinados fáciles para la oficina en cinco minutos",
  description: "Descubre ideas de peinados sencillos que puedes hacer antes de salir al trabajo, sin herramientas ni trucos difíciles. Lee el artículo completo y elige tu favorito para mañana.",
  alt: "Mujer con una cola baja ordenada frente a un espejo",
  keywords: ["peinados fáciles"],
  gloss_bn: "অফিসের জন্য সহজ হেয়ারস্টাইল",
  ...o,
});

describe("pinSchema", () => {
  it("accepts {pins:[...]} or a bare list, keeps good pins, drops broken ones, tolerates missing optional keys", () => {
    const ok = { title: "Un título largo y claro", description: "Una descripción suficientemente larga para pasar." };
    const r = pinSchema.safeParse({ pins: [ok, { title: "x" }, { ...ok, keywords: ["a", 3, "b"], alt: 5 }] });
    expect(r.success && r.data.length).toBe(2);
    expect(r.success && r.data[1]?.keywords.join("|")).toBe("a|b");
    expect(r.success && r.data[0]?.alt).toBe("");
    expect(pinSchema.safeParse({ pins: [{ title: "x" }] }).success).toBe(false);
  });
  it("prompt names the count and carries the article", () => {
    const p = pinPrompt({ title: "T", keyword: "k", locale: "es-MX", meta: null, headings: ["A"], highlights: ["h"] }, 4);
    expect(p.system.includes("exactly 4 pins")).toBe(true);
    expect(p.prompt.includes("Main keyword: k")).toBe(true);
  });
});

describe("checkPins", () => {
  it("passes a clean pin", () => {
    expect(checkPins([pin()], "Otro título distinto del artículo completo")[0]?.status).toBe("pass");
  });
  it("flags limits, price, year, hashtag, English, missing alt", () => {
    const n = (o: Partial<PinDraft>) => checkPins([pin(o)], "Zzz")[0]!.notes.join(" | ");
    expect(n({ title: "x".repeat(101) }).includes("limit 100")).toBe(true);
    expect(n({ title: "Corto" }).includes("short")).toBe(true);
    expect(n({ description: "d".repeat(501) }).includes("limit 500")).toBe(true);
    expect(n({ alt: "" }).includes("alt")).toBe(true);
    expect(n({ description: pin().description + " por 20 pesos" }).includes("price")).toBe(true);
    expect(n({ description: pin().description + " en 2025" }).includes("year")).toBe(true);
    expect(n({ description: pin().description + " #peinados" }).includes("hashtag")).toBe(true);
    expect(n({ description: "this is the best and you will have the look for your day with the tips from the blog and the ideas" }).includes("English")).toBe(true);
  });
  it("flags a title equal to the article title and only the LATER of two near-copies", () => {
    const t = "Peinados fáciles para la oficina en cinco minutos";
    expect(checkPins([pin()], t)[0]?.notes.some((x) => x.includes("article title"))).toBe(true);
    const r = checkPins([pin(), pin({ title: "Peinados fáciles para la oficina en cinco minutos hoy" }), pin({ title: "Ideas para cabello corto y rizado", description: "Cabello corto sin complicaciones: tres formas de peinarlo rápido, cuidarlo todos los días y lucirlo con seguridad en cualquier ocasión. Entra al artículo y guarda tu preferida." })], "Zzz");
    expect(r.map((x) => x.status).join(",")).toBe("pass,flag,pass");
    expect(r[1]?.notes.join().includes("pin 1")).toBe(true);
  });
  it("similarity is 1 for equal text, 0 for disjoint, accent-insensitive", () => {
    expect(similarity("Peinados fáciles", "peinados faciles")).toBe(1);
    expect(similarity("alpha beta gamma", "delta epsilon zeta")).toBe(0);
  });
});
