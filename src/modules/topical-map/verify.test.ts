import { describe, expect, it } from "vitest";
import { buildReport, checkAudit, checkCannibalization, checkCoverage, checkDuplicates, checkExistingContent, checkIntent, checkLanguage, checkPolicy, checkRules, checkSizeBalance, englishLeakage, type VItem } from "./verify";

const item = (o: Partial<VItem> & { id: string }): VItem => ({ keyword: o.id, variants: [], normKey: o.id, intent: "informational", flags: [], slug: o.id, title: `Los 10 mejores ${o.id}`, titleOptions: [], articleType: "A", listCount: 10, siloId: "s1", facetId: "f1", ...o });
const noQa = { ran: true, provider: "gemini", sampled: 10, flagged: [] };

describe("V1/V2", () => {
  it("same norm key fails; an unadjudicated pair above the threshold flags", () => {
    expect(checkDuplicates([item({ id: "a", normKey: "k" }), item({ id: "b", normKey: "k" })], [], 0.9).status).toBe("fail");
    const ab = [item({ id: "a" }), item({ id: "b" })];
    expect(checkDuplicates(ab, [{ a: "a", b: "b", cosine: 0.95, verdict: null }], 0.9).status).toBe("flag");
    expect(checkDuplicates(ab, [{ a: "a", b: "b", cosine: 0.95, verdict: "different" }], 0.9).status).toBe("pass");
  });
  it("closest pairs are listed with verdicts, max 20", () => {
    const ps = Array.from({ length: 30 }, (_, i) => ({ a: "a", b: `b${i}`, cosine: 0.5 + i / 100, verdict: "related" }));
    const c = checkCannibalization([item({ id: "a" })], ps);
    expect(c.status).toBe("pass");
    expect(c.count).toBe(20);
    expect(checkCannibalization([], []).status).toBe("skipped");
  });
  it("an unjudged pair is only a problem inside the judging band", () => {
    const below = [{ a: "a", b: "b", cosine: 0.5, verdict: null }];
    expect(checkCannibalization([item({ id: "a" }), item({ id: "b" })], below, 0.65).status).toBe("pass");
    const inside = [{ a: "a", b: "b", cosine: 0.7, verdict: null }];
    expect(checkCannibalization([item({ id: "a" }), item({ id: "b" })], inside, 0.65).status).toBe("flag");
    expect(checkCannibalization([item({ id: "a" }), item({ id: "b" })], [{ a: "a", b: "b", cosine: 0.4, verdict: "same" }], 0.65).status).toBe("flag");
  });
});

describe("V3/V4", () => {
  it("a facet with no items is a gap", () => {
    const items = Array.from({ length: 10 }, (_, i) => item({ id: `i${i}`, facetId: "f1" }));
    const c = checkCoverage(items, [{ id: "f1", name: "occasion" }, { id: "f2", name: "tool" }]);
    expect(c.status).toBe("flag");
    expect(c.summary.includes("tool")).toBe(true);
    expect(checkCoverage(items, []).status).toBe("skipped");
  });
  it("missing intent fails above 5%, mixed intent flags", () => {
    const many = Array.from({ length: 10 }, (_, i) => item({ id: `i${i}`, intent: i < 2 ? null : "informational" }));
    expect(checkIntent(many).status).toBe("fail");
    expect(checkIntent([item({ id: "a", flags: ["mixed_intent"] }), ...Array.from({ length: 9 }, (_, i) => item({ id: `x${i}` }))]).status).toBe("flag");
    expect(checkIntent([item({ id: "a" })]).status).toBe("pass");
  });
});

describe("V5/V6/V7", () => {
  it("detects obvious English leakage but not Spanish words or brand names", () => {
    expect(englishLeakage("best hairstyles for the beach")).toBe(true);
    expect(englishLeakage("peinados para la playa")).toBe(false);
    expect(englishLeakage("peinados con plancha ghd")).toBe(false);
  });
  it("a red language QA fails; no QA run flags; clean passes", () => {
    const items = [item({ id: "a" })];
    expect(checkLanguage(items, "es-MX", { ran: true, provider: "gemini", sampled: 4, flagged: [{ keyword: "a", issue: "wrong_locale" }] }).status).toBe("fail");
    expect(checkLanguage(items, "es-MX", { ran: false, reason: "no cross-provider model", sampled: 0, flagged: [] }).status).toBe("flag");
    expect(checkLanguage(items, "es-MX", noQa).status).toBe("pass");
  });
  it("V6 is skipped, never faked", () => expect(checkExistingContent().status).toBe("skipped"));
  it("policy: YMYL, brands, celebrities, price words", () => {
    const c = checkPolicy([item({ id: "a", keyword: "tratamiento para alopecia" }), item({ id: "b", keyword: "plancha dyson" }), item({ id: "c", keyword: "peinados selena gomez" }), item({ id: "d", keyword: "plancha barata", flags: ["price_words"] }), item({ id: "e", keyword: "peinados para boda" })]);
    expect(c.status).toBe("flag");
    expect(c.count).toBe(4);
  });
});

describe("V8/V9/V10", () => {
  it("audit rates decide the status; not run = skipped", () => {
    expect(checkAudit({ ran: false, reason: "x", sampledSame: 0, sampledSeparate: 0, wrongMerges: [], missedDuplicates: [] }).status).toBe("skipped");
    expect(checkAudit({ ran: true, provider: "gemini", sampledSame: 20, sampledSeparate: 20, wrongMerges: [], missedDuplicates: [] }).status).toBe("pass");
    expect(checkAudit({ ran: true, provider: "gemini", sampledSame: 20, sampledSeparate: 20, wrongMerges: [{ a: "1", b: "2", reason: "r" }, { a: "1", b: "3", reason: "r" }], missedDuplicates: [] }).status).toBe("flag");
    expect(checkAudit({ ran: true, provider: "gemini", sampledSame: 10, sampledSeparate: 10, wrongMerges: [{ a: "1", b: "2", reason: "r" }, { a: "1", b: "3", reason: "r" }], missedDuplicates: [] }).status).toBe("fail");
  });
  it("size: above the target max fails, below the min flags", () => {
    const items = Array.from({ length: 30 }, (_, i) => item({ id: `i${i}` }));
    const silos = [{ id: "s1", name: "x", size: 30 }];
    expect(checkSizeBalance(items, silos, { min: 20, max: 50 }).status).toBe("pass");
    expect(checkSizeBalance(items, silos, { min: 40, max: 50 }).status).toBe("flag");
    expect(checkSizeBalance(items, silos, { min: 5, max: 20 }).status).toBe("fail");
    // auto size: no minimum, and only a reached ceiling raises a flag
    expect(checkSizeBalance(items, silos, { min: 10, max: 200, auto: true }).status).toBe("pass");
    expect(checkSizeBalance(items, silos, { min: 10, max: 200, auto: true }).summary).toContain("auto size");
    const hit = checkSizeBalance(items, silos, { min: 10, max: 200, auto: true, trimmed: 12 });
    expect(hit.status).toBe("flag");
    expect(hit.summary).toContain("ceiling reached: 12");
    const more = checkSizeBalance(items, silos, { min: 10, max: 200, auto: true, unexplored: 30 });
    expect(more.status).toBe("flag");
    expect(more.summary).toContain("30 facet values were not explored");
  });
  it("rules: year in slug, duplicate slug, list number out of range fail; fallback title flags", () => {
    const range = { min: 7, max: 35 };
    expect(checkRules([item({ id: "a" })], range).status).toBe("pass");
    expect(checkRules([item({ id: "a", slug: "peinados-2026" })], range).status).toBe("fail");
    expect(checkRules([item({ id: "a", slug: "x" }), item({ id: "b", slug: "x" })], range).status).toBe("fail");
    expect(checkRules([item({ id: "a", listCount: 99 })], range).status).toBe("fail");
    expect(checkRules([item({ id: "a", title: "Los 10 mejores peinados 2026" })], range).status).toBe("fail");
    expect(checkRules([item({ id: "a", flags: ["title_fallback"] })], range).status).toBe("flag");
  });
});

describe("report", () => {
  it("any fail -> fail, any flag -> flag, skipped is listed and warned about", () => {
    const mk = (status: "pass" | "flag" | "fail" | "skipped") => ({ id: "V", name: "n", status, summary: "" });
    expect(buildReport([mk("pass"), mk("fail")]).verdict).toBe("fail");
    expect(buildReport([mk("pass"), mk("flag")]).verdict).toBe("flag");
    const r = buildReport([mk("pass"), mk("skipped")]);
    expect(r.verdict).toBe("pass");
    expect(r.note.includes("NOT verified")).toBe(true);
  });
});
