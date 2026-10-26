import { describe, expect, it } from "vitest";
import { editableOf, joinParagraphs, parseEditForm, partsOfEdit, rebuildAfterEdit, sectionRows, splitLines, splitParagraphs } from "./edit";
import type { ArticleParts } from "./render";

const parts = (): ArticleParts => ({
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
});

const form = (e: ReturnType<typeof editableOf>, over: Record<string, string> = {}) => {
  const f: Record<string, string> = { title: e.title, meta: e.meta, intro: joinParagraphs(e.intro), conclusion: joinParagraphs(e.conclusion) };
  e.items.forEach((it, i) => { f[`item_${i}_heading`] = it.heading; f[`item_${i}_paras`] = joinParagraphs(it.paragraphs); f[`item_${i}_bullets`] = it.bullets.join("\n"); });
  e.faq.forEach((q, i) => { f[`faq_${i}_q`] = q.question; f[`faq_${i}_a`] = q.answer; });
  return (k: string) => over[k] ?? f[k] ?? "";
};

describe("splitting", () => {
  it("paragraphs by blank line, lines joined; bullets one per line with markers stripped", () => {
    expect(splitParagraphs("uno\ndos\n\n\ntres  \n\n  ").join("|")).toBe("uno dos|tres");
    expect(splitLines("- a\n• b\n\nc").join("|")).toBe("a|b|c");
  });
});

describe("parseEditForm", () => {
  const e = editableOf(parts(), "Meta");
  it("round-trips an unchanged article", () => {
    const r = parseEditForm(form(e), 2, 1);
    expect(r.ok && JSON.stringify(r.value)).toBe(JSON.stringify(e));
  });
  it("rejects empty or too long fields with the field name", () => {
    const f = (over: Record<string, string>) => { const r = parseEditForm(form(e, over), 2, 1); return r.ok ? "ok" : r.error.field; };
    expect(f({ title: "short" })).toBe("title");
    expect(f({ intro: "  " })).toBe("intro");
    expect(f({ item_1_heading: "x" })).toBe("item_1_heading");
    expect(f({ item_0_paras: "" })).toBe("item_0_paras");
    expect(f({ item_0_paras: "a".repeat(1700) })).toBe("item_0_paras");
    expect(f({ faq_0_a: "corta" })).toBe("faq_0_a");
    expect(f({ conclusion: "" })).toBe("conclusion");
    expect(f({ meta: "m".repeat(401) })).toBe("meta");
  });
});

describe("sectionRows / partsOfEdit", () => {
  it("one row per stored section with word counts, in the shape the SQL expects", () => {
    const rows = sectionRows(editableOf(parts(), ""));
    expect(rows.map((r) => `${r.kind}:${r.idx}`).join(",")).toBe("intro:0,item:0,item:1,faq:0,conclusion:0");
    expect(rows[1]?.words).toBe(16);
  });
  it("keeps the locale and highlights of the base parts", () => {
    const e = editableOf(parts(), "");
    const p = partsOfEdit(parts(), { ...e, title: "Nuevo título largo" });
    expect(p.title).toBe("Nuevo título largo");
    expect(p.locale).toBe("es-MX");
    expect(p.highlights.length).toBe(2);
  });
});

describe("rebuildAfterEdit", () => {
  const base = { parts: parts(), slug: "peinados", n: 2, targetWords: 600, meta: "x".repeat(100), links: [{ plan_item_id: "a", role: "pillar" as const, title: "t", slug: "s" }], hadReview: true, lastVerdict: "major" };
  it("renders escaped HTML and replaces the AI review checks with ONE edited flag", () => {
    const r = rebuildAfterEdit(base);
    expect(r.html.includes("<h2>1. Cola baja</h2>")).toBe(true);
    expect(r.qa.checks.some((c) => c.id === "language_review" || c.id === "risky_claims")).toBe(false);
    const ed = r.qa.checks.filter((c) => c.id === "edited");
    expect(ed.length).toBe(1);
    expect(ed[0]?.summary.includes("major")).toBe(true);
    expect(r.qa.verdict).toBe("flag");
  });
  it("fixing text can clear red, but a mechanical failure still turns it red", () => {
    const p = parts();
    p.items[0]!.paragraphs = ["Cuesta 50 pesos y se hace rápido."];
    expect(rebuildAfterEdit({ ...base, parts: p }).qa.verdict).toBe("fail");
    expect(rebuildAfterEdit({ ...base, hadReview: false, lastVerdict: null }).qa.checks.find((c) => c.id === "edited")?.summary.startsWith("text edited by hand")).toBe(true);
  });
  it("meta falls back to the intro when the edited one is too short; schema follows the new title", () => {
    const r = rebuildAfterEdit({ ...base, meta: "corta", parts: { ...parts(), title: "Un título nuevo y largo" } });
    expect(r.meta.length >= 40).toBe(true);
    expect(r.schema[0]?.["headline"]).toBe("Un título nuevo y largo");
    expect(r.words > 20).toBe(true);
  });
});
