import { describe, expect, it } from "vitest";
import { faqSchema, introSchema, itemsSchema, outlinePrompt, outlineSchema, wordsPerItem } from "./prompts";
import { countWords, escapeHtml, plainText, renderArticle, type ArticleParts } from "./render";
import { englishShare, qaArticle } from "./qa";

const parts = (over: Partial<ArticleParts> = {}): ArticleParts => ({
  title: "7 ideas de peinados fáciles para el trabajo",
  locale: "es-MX",
  highlights: ["Ideas rápidas", "Sin herramientas"],
  intro: { paragraphs: ["Un peinado sencillo cambia tu mañana y te ahorra tiempo cada día."] },
  items: [
    { heading: "Cola baja", paragraphs: ["Una cola baja se hace en un minuto y se ve ordenada."], bullets: ["Usa una liga suave"] },
    { heading: "Trenza lateral", paragraphs: ["La trenza lateral sostiene el cabello durante todo el día."], bullets: [] },
  ],
  faq: { items: [{ question: "¿Sirve para cabello corto?", answer: "Sí, varias ideas funcionan con largo medio y hasta con cabello corto." }] },
  conclusion: { paragraphs: ["Elige la idea que más se parezca a tu rutina y pruébala esta semana."] },
  ...over,
});

describe("wordsPerItem", () => {
  it("shares the target after the fixed part and never goes below 60", () => {
    expect(wordsPerItem(1200, 7)).toBe(100);
    expect(wordsPerItem(1200, 100)).toBe(60);
    expect(wordsPerItem(3000, 0)).toBe(2500);
  });
});

describe("schemas", () => {
  it("outline needs exactly n items", () => {
    const ok = { highlights: ["a b", "c d"], intro_angle: "x", items: [{ heading: "Uno", angle: "a" }, { heading: "Dos", angle: "b" }], faq: [{ question: "¿Qué es esto?" }, { question: "¿Cómo se usa?" }], conclusion_angle: "z" };
    expect(outlineSchema(2).safeParse(ok).success).toBe(true);
    expect(outlineSchema(3).safeParse(ok).success).toBe(false);
  });
  it("outline tolerates a missing angle", () => {
    const o = { highlights: ["a", "b"], items: [{ heading: "Uno" }], faq: [{ question: "¿Qué es?" }, { question: "¿Cómo?" }] };
    const r = outlineSchema(1).safeParse(o);
    expect(r.success).toBe(true);
  });
  it("items keep good entries and drop bad ones", () => {
    const r = itemsSchema.safeParse({ results: [{ i: 1, paragraphs: ["hola"], bullets: ["a"] }, { i: 2, paragraphs: [] }, { index: 3, paragraphs: ["tres"] }] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.map((x) => x.i)).toEqual([1, 3]);
  });
  it("intro and faq validate", () => {
    expect(introSchema.safeParse({ intro: ["uno", "dos"] }).success).toBe(true);
    expect(introSchema.safeParse({ intro: [] }).success).toBe(false);
    expect(faqSchema.safeParse({ faq: [{ question: "¿Sí?", answer: "Sí, claro que sí, siempre." }], conclusion: ["fin"] }).success).toBe(true);
  });
  it("prompt names the exact count", () => {
    expect(outlinePrompt({ keyword: "k", variants: [], title: "t", n: 9, locale: "es-MX", silo: null }).system).toContain("EXACTLY 9");
  });
});

describe("render", () => {
  it("escapes everything", () => {
    const html = renderArticle(parts({ intro: { paragraphs: ["<script>alert(1)</script> & \"x\""] } }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(escapeHtml("a<b>'")).toBe("a&lt;b&gt;&#39;");
  });
  it("numbers the items and uses Spanish labels", () => {
    const html = renderArticle(parts());
    expect(html).toContain("<h2>1. Cola baja</h2>");
    expect(html).toContain("<h2>2. Trenza lateral</h2>");
    expect(html).toContain("Preguntas frecuentes");
    expect(renderArticle(parts({ locale: "en-US" }))).toContain("Frequently asked questions");
  });
  it("counts words", () => {
    expect(countWords("uno dos, tres-cuatro ¿qué?")).toBe(4);
    expect(countWords(plainText(parts())) > 40).toBe(true);
  });
});

describe("qa", () => {
  it("passes a clean article (length flag aside)", () => {
    const r = qaArticle(parts(), "peinados-faciles", 2, 100);
    expect(r.checks.find((c) => c.id === "items")?.status).toBe("pass");
    expect(["pass", "flag"]).toContain(r.verdict);
  });
  it("fails on wrong item count, price and year in slug", () => {
    expect(qaArticle(parts(), "x", 3, 100).verdict).toBe("fail");
    expect(qaArticle(parts({ intro: { paragraphs: ["Cuesta 50 pesos y es barato."] } }), "x", 2, 100).verdict).toBe("fail");
    expect(qaArticle(parts(), "peinados-2025", 2, 100).verdict).toBe("fail");
  });
  it("flags years in text, experience claims, cliches and English leaks", () => {
    const flag = (t: string) => qaArticle(parts({ intro: { paragraphs: [t] } }), "x", 2, 100).checks.filter((c) => c.status === "flag").map((c) => c.id);
    expect(flag("Desde 2024 todo cambió para tu cabello.")).toContain("year_body");
    expect(flag("En mi experiencia esto funciona muy bien siempre.")).toContain("experience");
    expect(flag("Sin lugar a dudas este es el mejor consejo.")).toContain("cliches");
    expect(flag("Use the best tips for your hair and the day with this guide that you will love")).toContain("language_leak");
  });
  it("measures english share", () => {
    expect(englishShare("")).toBe(0);
    expect(englishShare("the and with")).toBe(1);
  });
});

import { buildLinks, buildSchema, cutAtWord, metaDescription, publishChecks, withPublishChecks } from "./publish";

describe("publish data", () => {
  it("meta description: uses a good suggestion, else the intro, never over 155 and cut at a word", () => {
    const good = "Descubre ideas de peinados fáciles para el trabajo que se hacen en pocos minutos y sin herramientas.";
    expect(metaDescription(good, ["x"])).toBe(good);
    const fromIntro = metaDescription("corto", ["Un peinado sencillo cambia tu mañana y te ahorra tiempo cada día. ".repeat(6)]);
    expect(fromIntro.length <= 155).toBe(true);
    expect(fromIntro.endsWith(" ")).toBe(false);
    expect(cutAtWord("uno dos tres cuatro", 9)).toBe("uno dos");
    expect(metaDescription('Dice "hola"  mundo '.repeat(10), []).includes('"')).toBe(false);
  });
  it("schema: Article + ItemList + FAQPage with the language, and it survives JSON", () => {
    const s = buildSchema(parts(), "Meta");
    expect(s.map((n) => n["@type"]).join(",")).toBe("Article,ItemList,FAQPage");
    expect(s[0]?.["inLanguage"]).toBe("es-MX");
    expect((s[1]?.["itemListElement"] as unknown[]).length).toBe(2);
    expect(JSON.stringify(s).includes("acceptedAnswer")).toBe(true);
    expect(buildSchema(parts({ faq: { items: [] } }), "M").length).toBe(2);
  });
  it("links: pillar, siblings, children in order; drops self, rejected, untitled, duplicates, unknown", () => {
    const t = (id: string, status = "approved", title: string | null = `T${id}`) => ({ id, title, slug: `s-${id}`, status });
    const plan = { pillar: "p", siblings: ["a", "me", "r", "n", "a"], children: ["c", "zz", "p"], anchors: [] };
    const out = buildLinks(plan, "me", [t("p"), t("a"), t("me"), t("r", "rejected"), t("n", "approved", null), t("c")]);
    expect(out.map((l) => `${l.role}:${l.plan_item_id}`).join(",")).toBe("pillar:p,sibling:a,child:c");
    expect(buildLinks(null, "me", []).length).toBe(0);
  });
  it("checks: meta length, schema, links; verdict recomputed and re-running replaces them", () => {
    const base = qaArticle(parts(), "peinados", 2, 600);
    const ok = publishChecks("x".repeat(100), buildSchema(parts(), "m"), [{ plan_item_id: "a", role: "pillar", title: "t", slug: "s" }], "es-MX");
    expect(ok.map((c) => c.status).join(",")).toBe("pass,pass,pass");
    const bad = publishChecks("short", [{ "@type": "Article" }], [], "es-MX");
    expect(bad.map((c) => c.status).join(",")).toBe("flag,fail,flag");
    const r1 = withPublishChecks(base, bad);
    expect(r1.verdict).toBe("fail");
    const r2 = withPublishChecks(r1, ok);
    expect(r2.checks.filter((c) => c.id === "meta").length).toBe(1);
    expect(r2.checks.some((c) => c.id === "schema" && c.status === "pass")).toBe(true);
  });
  it("outline accepts a meta description and works without one", () => {
    const o = { highlights: ["a b", "c d"], intro_angle: "x", items: [{ heading: "Uno", angle: "a" }, { heading: "Dos", angle: "b" }], faq: [{ question: "¿Qué es esto?" }, { question: "¿Cómo se usa?" }], conclusion_angle: "z" };
    expect(outlineSchema(2).safeParse({ ...o, meta_description: "Una descripción" }).success).toBe(true);
    expect(outlineSchema(2).safeParse(o).success).toBe(true);
  });
});
