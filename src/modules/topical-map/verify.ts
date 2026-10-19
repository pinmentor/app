import type { Locale } from "./lexicon";
import type { ListRange } from "./titles";
import { MAX_TITLE_LENGTH } from "./titles";

/**
 * S9: the verification report (PLAN §3.9). The deterministic checks are pure and tested here; the two checks that need
 * a model (V5 language QA, V8 independent audit) are run by the stage and passed in as plain results, so the report
 * assembly stays testable and an unavailable cross-provider model shows up as `skipped`, never as a silent pass.
 *
 * status: pass | flag (look at it) | fail (blocks: the map stays a draft) | skipped (could not run, said why)
 */
export type CheckStatus = "pass" | "flag" | "fail" | "skipped";
export type Check = { id: string; name: string; status: CheckStatus; summary: string; count?: number; details?: unknown[] };

export type VItem = {
  id: string;
  keyword: string;
  variants: string[];
  normKey: string | null;
  intent: string | null;
  flags: string[];
  slug: string | null;
  title: string | null;
  titleOptions: string[];
  articleType: "A" | "B";
  listCount: number | null;
  siloId: string | null;
  facetId: string | null;
};
export type VPair = { a: string; b: string; cosine: number; verdict: string | null };
export type VFacet = { id: string; name: string };
export type VSilo = { id: string; name: string; size: number };

const check = (id: string, name: string, status: CheckStatus, summary: string, details?: unknown[]): Check => ({
  id, name, status, summary, ...(details ? { count: details.length, details: details.slice(0, 50) } : {}),
});

/** V1: no two primaries share a norm_key; no pair above the auto-merge threshold is left without a "stay separate" verdict. */
export function checkDuplicates(items: VItem[], pairs: VPair[], high: number): Check {
  const byKey = new Map<string, string[]>();
  for (const it of items) if (it.normKey) (byKey.get(it.normKey) ?? byKey.set(it.normKey, []).get(it.normKey)!).push(it.keyword);
  const exact = [...byKey.values()].filter((v) => v.length > 1);
  const label = new Map(items.map((i) => [i.id, i.keyword]));
  const open = pairs.filter((p) => p.cosine >= high && !["different", "related", "parent_child"].includes(p.verdict ?? ""));
  const details = [
    ...exact.map((k) => ({ kind: "same_norm_key", keywords: k })),
    ...open.map((p) => ({ kind: "above_threshold", a: label.get(p.a) ?? p.a, b: label.get(p.b) ?? p.b, cosine: round2(p.cosine), verdict: p.verdict })),
  ];
  if (exact.length > 0) return check("V1", "Duplicates", "fail", `${exact.length} primaries share the same normalised key`, details);
  if (open.length > 0) return check("V1", "Duplicates", "flag", `${open.length} pairs above the merge threshold were not adjudicated as separate`, details);
  return check("V1", "Duplicates", "pass", "no duplicate primaries");
}

/** V2: the closest primary pairs with their verdicts (the user sees them). Pairs the judge called `same` that survived are the problem. */
export function checkCannibalization(items: VItem[], pairs: VPair[]): Check {
  const label = new Map(items.map((i) => [i.id, i.keyword]));
  const top = [...pairs].sort((x, y) => y.cosine - x.cosine || x.a.localeCompare(y.a) || x.b.localeCompare(y.b)).slice(0, 20);
  const details = top.map((p) => ({ a: label.get(p.a) ?? p.a, b: label.get(p.b) ?? p.b, cosine: round2(p.cosine), verdict: p.verdict ?? "not judged" }));
  const risky = top.filter((p) => p.verdict === "same" || p.verdict === null).length;
  if (top.length === 0) return check("V2", "Cannibalization", "skipped", "no neighbour pairs available (no vectors)");
  return check("V2", "Cannibalization", risky > 0 ? "flag" : "pass", risky > 0 ? `${risky} of the ${top.length} closest pairs are unadjudicated or marked same` : `the ${top.length} closest pairs are all adjudicated as separate`, details);
}

/** V3: items per facet. A facet with under 40% of the average share (or none) is a gap the user can fill. */
export function checkCoverage(items: VItem[], facets: VFacet[]): Check {
  if (facets.length === 0) return check("V3", "Coverage", "skipped", "no facets recorded");
  const counts = new Map(facets.map((f) => [f.id, 0]));
  for (const it of items) if (it.facetId && counts.has(it.facetId)) counts.set(it.facetId, counts.get(it.facetId)! + 1);
  const avg = [...counts.values()].reduce((a, b) => a + b, 0) / facets.length;
  const rows = facets.map((f) => ({ facet: f.name, items: counts.get(f.id)! }));
  const gaps = rows.filter((r) => r.items === 0 || r.items < avg * 0.4);
  return check("V3", "Coverage", gaps.length > 0 ? "flag" : "pass", gaps.length > 0 ? `${gaps.length} of ${facets.length} facets are thin: ${gaps.map((g) => g.facet).join(", ")}` : "every facet is covered", rows);
}

/** V4: every item has one intent; mixed ones are listed. */
export function checkIntent(items: VItem[]): Check {
  const missing = items.filter((i) => !i.intent);
  const mixed = items.filter((i) => i.flags.includes("mixed_intent"));
  if (missing.length > items.length * 0.05) return check("V4", "Intent integrity", "fail", `${missing.length} items have no intent`, missing.map((m) => m.keyword));
  const details = [...missing.map((m) => ({ keyword: m.keyword, issue: "no intent" })), ...mixed.map((m) => ({ keyword: m.keyword, issue: "mixed intent" }))];
  return details.length > 0 ? check("V4", "Intent integrity", "flag", `${missing.length} without intent, ${mixed.length} with mixed intent`, details) : check("V4", "Intent integrity", "pass", "every item has one clear intent");
}

const EN_WORDS = new Set(["the", "and", "for", "with", "best", "how", "to", "of", "your", "you", "ideas", "easy", "hairstyles", "hairstyle", "hair", "tutorial", "guide", "tips"]);
const EN_STRONG = new Set(["the", "and", "for", "with", "best", "how", "your", "you", "hairstyles", "hairstyle", "tutorial", "guide", "tips"]);

/** Deterministic English-leakage heuristic for Spanish maps: strong English function/topic words (brands are not in the list). */
export function englishLeakage(text: string): boolean {
  const words = text.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").split(/[^a-z]+/).filter(Boolean);
  const hits = words.filter((w) => EN_WORDS.has(w));
  return words.some((w) => EN_STRONG.has(w)) && hits.length >= 1 && words.length > 0 && hits.length / words.length >= 0.25;
}

export type LangQa = { ran: boolean; reason?: string; provider?: string; sampled: number; flagged: { keyword: string; issue: string }[] };

/** V5: English leakage (heuristic, all items) + the cross-provider language QA of a sample. A red QA (>= 25% flagged) fails. */
export function checkLanguage(items: VItem[], locale: Locale, qa: LangQa): Check {
  const leaks = locale === "en-US" ? [] : items.filter((i) => englishLeakage(i.keyword) || (i.title ? englishLeakage(i.title) : false)).map((i) => ({ keyword: i.keyword, issue: "english_leakage (heuristic)" }));
  const flagged = [...leaks, ...qa.flagged.map((f) => ({ keyword: f.keyword, issue: f.issue }))];
  const rate = qa.ran && qa.sampled > 0 ? qa.flagged.length / qa.sampled : 0;
  const note = qa.ran ? `QA by ${qa.provider ?? "another provider"} on ${qa.sampled} samples` : `language QA did not run (${qa.reason ?? "unavailable"})`;
  if (rate >= 0.25) return check("V5", "Language / locale", "fail", `${qa.flagged.length} of ${qa.sampled} sampled items flagged; ${note}`, flagged);
  if (flagged.length > 0 || !qa.ran) return check("V5", "Language / locale", "flag", `${flagged.length} flagged; ${note}`, flagged);
  return check("V5", "Language / locale", "pass", `no language problems found; ${note}`);
}

/** V6 needs the site's existing posts (WordPress comes in a later batch). Stated, never faked. */
export function checkExistingContent(): Check {
  return check("V6", "Existing content", "skipped", "no site connected yet: nothing to compare against");
}

const YMYL = /\b(alopecia|ca[ií]da del cabello|calvicie|caspa|dermatitis|psoriasis|infecci[oó]n|hongos|piojos?|tratamiento m[eé]dico|medicamento|cura|enfermedad|hair loss|baldness|dandruff)\b/i;
const BRANDS = /\b(dyson|ghd|babyliss|remington|l'?or[eé]al|garnier|pantene|wella|revlon|olaplex|kardashian|selena gomez|taylor swift|bad bunny|shakira|zendaya|beyonc[eé]|rihanna|harry styles)\b/i;
const PRICE_FLAG = "price_words";

/** V7: YMYL/medical claims, brand or celebrity names, price words. A heuristic word list, not a legal review (stated in the summary). */
export function policyFlags(keyword: string): string[] {
  const f: string[] = [];
  if (YMYL.test(keyword)) f.push("ymyl");
  if (BRANDS.test(keyword)) f.push("brand_or_celebrity");
  return f;
}

export function checkPolicy(items: VItem[]): Check {
  const details = items
    .map((i) => ({ keyword: i.keyword, flags: [...new Set([...policyFlags(i.keyword), ...i.flags.filter((f) => f === PRICE_FLAG)])] }))
    .filter((d) => d.flags.length > 0);
  return details.length > 0
    ? check("V7", "Policy flags", "flag", `${details.length} items need a human look (word-list heuristic, not a legal review)`, details)
    : check("V7", "Policy flags", "pass", "no YMYL, brand, celebrity or price words found (word-list heuristic)");
}

export type Audit = {
  ran: boolean;
  reason?: string;
  provider?: string;
  sampledSame: number;
  sampledSeparate: number;
  wrongMerges: { a: string; b: string; reason: string }[];
  missedDuplicates: { a: string; b: string; reason: string }[];
};

/** V8: an independent model re-judges a sample of the pairs; the disagreement rates estimate wrong merges and missed duplicates. */
export function checkAudit(a: Audit): Check {
  if (!a.ran) return check("V8", "Independent audit", "skipped", `audit did not run (${a.reason ?? "no cross-provider model available"})`);
  const wrongRate = a.sampledSame > 0 ? a.wrongMerges.length / a.sampledSame : 0;
  const missRate = a.sampledSeparate > 0 ? a.missedDuplicates.length / a.sampledSeparate : 0;
  const summary = `by ${a.provider ?? "another provider"}: est. wrong-merge rate ${pct(wrongRate)} (${a.wrongMerges.length}/${a.sampledSame}), est. missed-duplicate rate ${pct(missRate)} (${a.missedDuplicates.length}/${a.sampledSeparate}); a small sample, an estimate only`;
  const details = [...a.wrongMerges.map((x) => ({ kind: "wrong_merge", ...x })), ...a.missedDuplicates.map((x) => ({ kind: "missed_duplicate", ...x }))];
  const status: CheckStatus = wrongRate > 0.15 || missRate > 0.25 ? "fail" : wrongRate > 0.05 || missRate > 0.1 ? "flag" : "pass";
  return check("V8", "Independent audit", status, summary, details.length > 0 ? details : undefined);
}

/** V9: size inside the target range, silo sizes inside 15-40, the A/B mix reported. */
export function checkSizeBalance(items: VItem[], silos: VSilo[], target: { min: number; max: number }, siloRange = { min: 15, max: 40 }): Check {
  const n = items.length;
  const outside = silos.filter((s) => s.size < siloRange.min || s.size > siloRange.max);
  const b = items.filter((i) => i.articleType === "B").length;
  const parts = [`${n} items (target ${target.min}-${target.max})`, `${silos.length} silos, ${outside.length} outside ${siloRange.min}-${siloRange.max}`, `Type B ${b}, Type A ${n - b}`];
  const details = outside.map((s) => ({ silo: s.name, size: s.size }));
  if (n > target.max) return check("V9", "Size & balance", "fail", parts.join("; "), details);
  const small = n < target.min || outside.length > silos.length * 0.25;
  return check("V9", "Size & balance", small ? "flag" : "pass", parts.join("; "), details.length > 0 ? details : undefined);
}

/** V10: no year in a slug, list number inside the range, title length, unique slugs, 3 title options or a flagged fallback. */
export function checkRules(items: VItem[], range: ListRange): Check {
  const bad: { keyword: string; issue: string }[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (!it.slug) bad.push({ keyword: it.keyword, issue: "no slug" });
    else {
      if (/(^|-)(19|20)\d{2}(-|$)/.test(it.slug)) bad.push({ keyword: it.keyword, issue: `year in slug: ${it.slug}` });
      if (seen.has(it.slug)) bad.push({ keyword: it.keyword, issue: `duplicate slug: ${it.slug}` });
      seen.add(it.slug);
    }
    if (it.articleType === "A" && (it.listCount === null || it.listCount < range.min || it.listCount > range.max)) bad.push({ keyword: it.keyword, issue: `list number ${it.listCount ?? "missing"} outside ${range.min}-${range.max}` });
    if (!it.title) bad.push({ keyword: it.keyword, issue: "no title" });
    else {
      if (it.title.length > MAX_TITLE_LENGTH + 10) bad.push({ keyword: it.keyword, issue: `title too long (${it.title.length})` });
      if (/\b(19|20)\d{2}\b/.test(it.title)) bad.push({ keyword: it.keyword, issue: `year in title: ${it.title}` });
    }
  }
  const fallbacks = items.filter((i) => i.flags.includes("title_fallback")).length;
  if (bad.length > 0) return check("V10", "Rules", "fail", `${bad.length} rule violations`, bad);
  if (fallbacks > 0) return check("V10", "Rules", "flag", `${fallbacks} items only have a fallback title (rewrite them)`);
  return check("V10", "Rules", "pass", "slugs, list numbers and titles follow the rules");
}

export type Report = {
  verdict: "pass" | "flag" | "fail";
  generated_at: string;
  counts: { pass: number; flag: number; fail: number; skipped: number };
  checks: Check[];
  note: string;
};

/** Overall verdict: any fail -> fail (the map stays a draft), else any flag -> flag, else pass. Skipped checks are listed, not hidden. */
export function buildReport(checks: Check[], now = new Date()): Report {
  const counts = { pass: 0, flag: 0, fail: 0, skipped: 0 };
  for (const c of checks) counts[c.status]++;
  const verdict = counts.fail > 0 ? "fail" : counts.flag > 0 ? "flag" : "pass";
  return {
    verdict,
    generated_at: now.toISOString(),
    counts,
    checks,
    note: counts.skipped > 0 ? "Skipped checks were NOT verified; a pass does not cover them." : "",
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (r: number) => `${Math.round(r * 100)}%`;
