import { z } from "zod";
import type { Locale } from "@/modules/topical-map/lexicon";
import { shortText, withKeys } from "@/modules/topical-map/tolerant";
import { LANG } from "./prompts";
import type { QaCheck, QaReport, QaStatus } from "./qa";
import type { ArticleParts } from "./render";

/**
 * Language review (PLAN §5.1 point 1): a SECOND model reads the finished article and reports language problems and risky
 * claims, in English, with exact quotes so the owner can check them (or ask a native speaker) without reading Spanish.
 * The judge is a different provider than the writer whenever one is available; when only one provider has a key, the same
 * provider reviews and the result says so (`cross_model: false`): a weaker check, never presented as an independent one.
 * What it is NOT: proof of correctness. It lowers risk; it does not remove it.
 */

export const ISSUE_TYPES = ["grammar", "agreement", "regional", "calque", "english", "spelling", "tone", "repetition", "other"] as const;
export const CLAIM_KINDS = ["number", "health", "brand", "absolute", "other"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];
export type ClaimKind = (typeof CLAIM_KINDS)[number];

/** The article as numbered, labelled text for the judge (labels come back in `where`). */
export function reviewText(a: ArticleParts): string {
  const out: string[] = [`[title] ${a.title}`];
  if (a.highlights.length) out.push(`[highlights] ${a.highlights.join(" | ")}`);
  a.intro.paragraphs.forEach((p, k) => out.push(`[intro ${k + 1}] ${p}`));
  a.items.forEach((it, i) => {
    out.push(`[item ${i + 1} heading] ${it.heading}`);
    it.paragraphs.forEach((p, k) => out.push(`[item ${i + 1} text ${k + 1}] ${p}`));
    it.bullets.forEach((b, k) => out.push(`[item ${i + 1} bullet ${k + 1}] ${b}`));
  });
  a.faq.items.forEach((q, k) => {
    out.push(`[faq ${k + 1} question] ${q.question}`);
    out.push(`[faq ${k + 1} answer] ${q.answer}`);
  });
  a.conclusion.paragraphs.forEach((p, k) => out.push(`[conclusion ${k + 1}] ${p}`));
  return out.join("\n");
}

export function reviewPrompt(text: string, locale: Locale): { system: string; prompt: string } {
  return {
    system:
      `You are a strict native-level proofreader of ${LANG[locale]} reviewing a blog article for a publisher who cannot read the language. ` +
      `Find real language problems only: grammar, gender/number agreement, wrong or non-regional vocabulary (flag words that are Spain-only or unnatural for the requested variant), ` +
      `literal translations from English (calques), English words left in, spelling, clumsy or unnatural phrasing, heavy repetition. Do not flag personal taste or harmless style. ` +
      `Also list RISKY CLAIMS the publisher should verify before publishing: specific numbers or percentages, health or medical claims, brand or product names, absolute promises ("always", "guaranteed", "never fails"). ` +
      `Write the "problem", "fix" and "note" fields in English. "excerpt" is an EXACT short quote (max 120 characters) copied from the text, in the original language. "where" is the label in square brackets, e.g. "item 3 text 1". ` +
      `Return one JSON object only: {"verdict":"good"|"minor"|"major","issues":[{"where":"","type":"grammar"|"agreement"|"regional"|"calque"|"english"|"spelling"|"tone"|"repetition"|"other","excerpt":"","problem":"","fix":""}],"risky_claims":[{"where":"","kind":"number"|"health"|"brand"|"absolute"|"other","excerpt":"","note":""}]}. ` +
      `"good" = nothing worth fixing; "minor" = a few small issues; "major" = errors a native reader would notice at once or text that sounds machine-translated. At most 12 issues and 8 risky claims, most serious first.`,
    prompt: text,
  };
}

const oneOf = <T extends string>(allowed: readonly T[], fallback: T) => (v: unknown): T => {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
};
const list = <T extends z.ZodType>(item: T, max: number) =>
  z.unknown().transform((v) => (Array.isArray(v) ? v : [])).transform((xs) => xs.flatMap((x) => { const r = item.safeParse(x); return r.success ? [r.data as z.output<T>] : []; }).slice(0, max));

const issueSchema = withKeys(["where", "type", "excerpt", "problem", "fix"], z.object({
  where: z.unknown().transform(shortText(40)),
  type: z.unknown().transform(oneOf(ISSUE_TYPES, "other")),
  excerpt: z.unknown().transform(shortText(160)),
  problem: z.unknown().transform(shortText(300)),
  fix: z.unknown().transform(shortText(300)),
}));
const claimSchema = withKeys(["where", "kind", "excerpt", "note"], z.object({
  where: z.unknown().transform(shortText(40)),
  kind: z.unknown().transform(oneOf(CLAIM_KINDS, "other")),
  excerpt: z.unknown().transform(shortText(160)),
  note: z.unknown().transform(shortText(300)),
}));
export const reviewSchema = withKeys(["verdict", "issues", "risky_claims"], z.object({
  verdict: z.unknown().transform(oneOf(["good", "minor", "major"] as const, "minor")),
  issues: list(issueSchema, 12),
  risky_claims: list(claimSchema, 8),
}));
export type ReviewAnswer = z.output<typeof reviewSchema>;

/** What is stored in articles.review. */
export type StoredReview = {
  status: "done" | "skipped";
  verdict?: "good" | "minor" | "major";
  issues: ReviewAnswer["issues"];
  risky_claims: ReviewAnswer["risky_claims"];
  model?: string;
  provider?: string;
  cross_model?: boolean;
  reason?: string;
};

export const storedReviewSchema = z.object({
  status: z.enum(["done", "skipped"]),
  verdict: z.enum(["good", "minor", "major"]).optional(),
  issues: z.array(z.object({ where: z.string(), type: z.string(), excerpt: z.string(), problem: z.string(), fix: z.string() })).default([]),
  risky_claims: z.array(z.object({ where: z.string(), kind: z.string(), excerpt: z.string(), note: z.string() })).default([]),
  model: z.string().optional(),
  provider: z.string().optional(),
  cross_model: z.boolean().optional(),
  reason: z.string().optional(),
});

/** The checks the review adds to the QA report. A review that did not run is a yellow flag, never a silent pass. */
export function reviewChecks(r: StoredReview): QaCheck[] {
  if (r.status === "skipped") return [{ id: "language_review", status: "flag", summary: `language review did not run (${r.reason ?? "unknown"}); read it carefully or check it with a native speaker` }];
  const n = r.issues.length;
  const status: QaStatus = r.verdict === "major" ? "fail" : r.verdict === "good" && n === 0 ? "pass" : "flag";
  const checks: QaCheck[] = [
    { id: "language_review", status, summary: `${r.verdict ?? "?"}: ${n} issue${n === 1 ? "" : "s"} found${r.cross_model === false ? " (same provider as the writer: a weaker check)" : ""}` },
  ];
  const c = r.risky_claims.length;
  const health = r.risky_claims.filter((x) => x.kind === "health").length;
  checks.push({ id: "risky_claims", status: c === 0 ? "pass" : "flag", summary: c === 0 ? "no risky claims listed" : `${c} claim${c === 1 ? "" : "s"} to verify${health ? ` (${health} health-related)` : ""}` });
  return checks;
}

/** The mechanical report plus the review checks, verdict recomputed (any fail -> fail, any flag -> flag). */
export function mergeReview(qa: QaReport, r: StoredReview): QaReport {
  const checks = [...qa.checks.filter((c) => c.id !== "language_review" && c.id !== "risky_claims"), ...reviewChecks(r)];
  const verdict: QaStatus = checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "flag") ? "flag" : "pass";
  return { ...qa, checks, verdict };
}

export type Light = "green" | "yellow" | "red";
export const lightOf = (verdict: unknown): Light => (verdict === "pass" ? "green" : verdict === "fail" ? "red" : "yellow");
export const LIGHT_TEXT: Record<Light, string> = { green: "All checks passed", yellow: "Small flags: check before use", red: "Blocked: serious problem found" };
