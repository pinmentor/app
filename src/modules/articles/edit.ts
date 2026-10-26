import type { ArticleParts } from "./render";
import { countWords, plainText, renderArticle } from "./render";
import { qaArticle, type QaCheck, type QaReport, type QaStatus } from "./qa";
import { buildSchema, metaDescription, publishChecks, withPublishChecks, type RelatedLink, type SchemaNode } from "./publish";

/**
 * Hand editing of a finished article (Batch 20). The form shows the text as plain fields; saving validates every field,
 * rebuilds the parts, re-renders the (escaped) HTML and re-runs the mechanical QA. The AI language review is NOT re-run:
 * its two checks are replaced by one flag saying the text changed after the review, so a human edit can clear a red review verdict
 * but is never presented as a pass.
 */
export type Editable = {
  title: string;
  meta: string;
  intro: string[];
  items: { heading: string; paragraphs: string[]; bullets: string[] }[];
  faq: { question: string; answer: string }[];
  conclusion: string[];
};

const MAX_PARA = 1600;
const clean = (s: string) => s.replace(/\r/g, "").trim();
/** Paragraphs are separated by a blank line. */
export const splitParagraphs = (s: string) => clean(s).split(/\n\s*\n/).map((x) => x.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
/** Bullets: one per line. */
export const splitLines = (s: string) => clean(s).split("\n").map((x) => x.replace(/^[-•*]\s*/, "").trim()).filter(Boolean);
export const joinParagraphs = (xs: string[]) => xs.join("\n\n");

export function editableOf(parts: ArticleParts, meta: string | null): Editable {
  return {
    title: parts.title,
    meta: meta ?? "",
    intro: parts.intro.paragraphs,
    items: parts.items.map((i) => ({ heading: i.heading, paragraphs: i.paragraphs, bullets: i.bullets })),
    faq: parts.faq.items.map((q) => ({ question: q.question, answer: q.answer })),
    conclusion: parts.conclusion.paragraphs,
  };
}

export type EditError = { field: string; message: string };

/** Reads the form fields (names: title, meta, intro, conclusion, item_<i>_heading|paras|bullets, faq_<i>_q|a) and validates them. */
export function parseEditForm(get: (name: string) => string, n: number, faqN: number): { ok: true; value: Editable } | { ok: false; error: EditError } {
  const bad = (field: string, message: string) => ({ ok: false as const, error: { field, message } });
  const title = clean(get("title"));
  if (title.length < 8 || title.length > 160) return bad("title", "The title needs 8 to 160 characters.");
  const meta = clean(get("meta")).replace(/\s+/g, " ");
  if (meta.length > 400) return bad("meta", "The meta description is too long (400 characters at most; aim for 70 to 155).");
  const paras = (field: string, raw: string, min: number) => {
    const xs = splitParagraphs(raw);
    if (xs.length < min) return `${field} cannot be empty.`;
    if (xs.some((x) => x.length > MAX_PARA)) return `A paragraph in ${field} is longer than ${MAX_PARA} characters. Split it with a blank line.`;
    return xs;
  };
  const intro = paras("The introduction", get("intro"), 1);
  if (typeof intro === "string") return bad("intro", intro);
  const conclusion = paras("The conclusion", get("conclusion"), 1);
  if (typeof conclusion === "string") return bad("conclusion", conclusion);
  const items: Editable["items"] = [];
  for (let i = 0; i < n; i++) {
    const heading = clean(get(`item_${i}_heading`));
    if (heading.length < 2 || heading.length > 120) return bad(`item_${i}_heading`, `Item ${i + 1}: the heading needs 2 to 120 characters.`);
    const p = paras(`Item ${i + 1}`, get(`item_${i}_paras`), 1);
    if (typeof p === "string") return bad(`item_${i}_paras`, p);
    const bullets = splitLines(get(`item_${i}_bullets`)).slice(0, 8);
    if (bullets.some((b) => b.length > 300)) return bad(`item_${i}_bullets`, `Item ${i + 1}: a bullet is longer than 300 characters.`);
    items.push({ heading, paragraphs: p, bullets });
  }
  const faq: Editable["faq"] = [];
  for (let i = 0; i < faqN; i++) {
    const question = clean(get(`faq_${i}_q`)).replace(/\s+/g, " ");
    const answer = clean(get(`faq_${i}_a`)).replace(/\s+/g, " ");
    if (question.length < 3 || question.length > 240) return bad(`faq_${i}_q`, `Question ${i + 1} needs 3 to 240 characters.`);
    if (answer.length < 10 || answer.length > 900) return bad(`faq_${i}_a`, `The answer to question ${i + 1} needs 10 to 900 characters.`);
    faq.push({ question, answer });
  }
  return { ok: true, value: { title, meta, intro, items, faq, conclusion } };
}

export const partsOfEdit = (base: ArticleParts, e: Editable): ArticleParts => ({
  ...base,
  title: e.title,
  intro: { paragraphs: e.intro },
  items: e.items,
  faq: { items: e.faq },
  conclusion: { paragraphs: e.conclusion },
});

/** The section rows to store (shape of article_edit_save, 0024). */
export function sectionRows(e: Editable): { kind: string; idx: number; content: unknown; words: number }[] {
  const w = (xs: string[]) => countWords(xs.join(" "));
  return [
    { kind: "intro", idx: 0, content: { paragraphs: e.intro }, words: w(e.intro) },
    ...e.items.map((it, i) => ({ kind: "item", idx: i, content: it, words: w([...it.paragraphs, ...it.bullets]) })),
    { kind: "faq", idx: 0, content: { items: e.faq }, words: w(e.faq.flatMap((q) => [q.question, q.answer])) },
    { kind: "conclusion", idx: 0, content: { paragraphs: e.conclusion }, words: w(e.conclusion) },
  ];
}

const REVIEW_IDS = new Set(["language_review", "risky_claims", "edited"]);

/** Everything derived from the edited text: HTML, QA (mechanical + publish checks + the "edited after review" flag), word count, schema. */
export function rebuildAfterEdit(a: { parts: ArticleParts; slug: string | null; n: number; targetWords: number; meta: string; links: RelatedLink[]; hadReview: boolean; lastVerdict: string | null }): {
  html: string; qa: QaReport; words: number; schema: SchemaNode[]; meta: string;
} {
  const meta = metaDescription(a.meta, a.parts.intro.paragraphs);
  const schema = buildSchema(a.parts, meta);
  const base = withPublishChecks(qaArticle(a.parts, a.slug, a.n, a.targetWords), publishChecks(meta, schema, a.links, a.parts.locale));
  const flag: QaCheck = { id: "edited", status: "flag", summary: a.hadReview ? `text edited after the language review (it said: ${a.lastVerdict ?? "unknown"}); read your changes yourself` : "text edited by hand; the language review did not cover this version" };
  const checks = [...base.checks.filter((c) => !REVIEW_IDS.has(c.id)), flag];
  const verdict: QaStatus = checks.some((c) => c.status === "fail") ? "fail" : "flag";
  return { html: renderArticle(a.parts), qa: { ...base, checks, verdict }, words: countWords(plainText(a.parts)), schema, meta };
}
