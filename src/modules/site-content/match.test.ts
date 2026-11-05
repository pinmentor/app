import { describe, expect, it } from "vitest";
import { buildIndex, compareTokens } from "./match";

const docs = [
  { url: "https://e.com/peinados-para-bodas/", title: "Peinados para bodas", h1: null },
  { url: "https://e.com/trenzas-de-lado-faciles/", title: "Trenzas de lado fáciles paso a paso", h1: null },
  { url: "https://e.com/blog", title: "Blog", h1: "Blog" },
];
const find = buildIndex(docs, "es-MX");

describe("V6 match", () => {
  it("same words in other order / plural / accents is the same page", () => {
    expect(find("bodas peinados")?.kind).toBe("same");
    expect(find("Peinado para Boda")?.kind).toBe("same");
  });
  it("a keyword inside a page's words is close", () => {
    expect(find("trenzas de lado")?.kind).toBe("close");
  });
  it("an unrelated keyword matches nothing", () => {
    expect(find("recetas de pastel de chocolate")).toBeNull();
  });
  it("a one-word title cannot swallow a topic", () => {
    expect(find("blog de peinados")).toBeNull();
  });
  it("compareTokens needs two words on both sides", () => {
    expect(compareTokens(new Set(["a"]), new Set(["a", "b"]))).toBeNull();
  });
  it("falls back to the address slug when a page has no title", () => {
    const f = buildIndex([{ url: "https://e.com/cortes-de-pelo-corto/", title: null, h1: null }], "es-MX");
    expect(f("cortes de pelo corto")?.via).toBe("url");
  });
});
