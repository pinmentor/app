import { z } from "zod";
import type { Locale } from "@/modules/topical-map/lexicon";
import { shortText, tolerantList, withKeys } from "@/modules/topical-map/tolerant";

/**
 * Prompts and answer schemas of the article writer (PLAN §5, Type A = ideas / list). The model writes PLAIN TEXT
 * (paragraphs, bullets); the HTML is built by code (render.ts) and escaped, so a model can never put markup in a page.
 * No research step yet: the prompts forbid statistics, studies, brands, health claims and first-person experience, because
 * nothing here can ground them (PLAN §5 "fact grounding" comes with the research step).
 */

export const LANG: Record<Locale, string> = {
  "es-MX": "Mexican Spanish (es-MX: Mexican vocabulary, 'tú' form, no Spain-only words)",
  "es-US": "US Latino Spanish (es-US, 'tú' form, neutral vocabulary)",
  "es-ES": "Spanish from Spain (es-ES)",
  "en-US": "American English",
};

export const FIXED_WORDS = 500; // intro + FAQ + conclusion; the rest of the target is shared by the N items
export const ITEMS_PER_JOB = 5; // one LLM call writes at most 5 items (keeps a step well under 60 s)

/** Words one list item should get: (target - fixed) / N, never below 60. */
export function wordsPerItem(targetWords: number, n: number): number {
  return Math.max(60, Math.round((targetWords - FIXED_WORDS) / Math.max(1, n)));
}

export const RULES =
  "Hard rules: write everything in the requested language and regional variant. Never mention prices, discounts, costs or currencies. Never write a year. " +
  "Never invent personal experience or testing (no 'I tried', 'in my experience', 'we tested'). No statistics, percentages, studies, quotes or brand names. " +
  "No medical or health claims; for hair or skin damage topics stay with general, harmless care advice. Do not mention that you are an AI. " +
  "Avoid stock openers and filler ('in today's world', 'without a doubt', 'in conclusion', 'it is important to note'). Concrete, useful, varied sentences.";

const text = (max: number) => z.unknown().transform(shortText(max));
const paragraphs = (min: number, max: number, each: number) =>
  z.array(z.unknown()).transform((xs) => xs.flatMap((x) => (typeof x === "string" && x.trim().length > 0 ? [x.trim().slice(0, each)] : []))).refine((a) => a.length >= min && a.length <= max + 2, { message: "paragraph count" }).transform((a) => a.slice(0, max));

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------
export type OutlineInput = { keyword: string; variants: string[]; title: string; n: number; locale: Locale; silo: string | null };

export function outlinePrompt(i: OutlineInput): { system: string; prompt: string } {
  return {
    system:
      `You plan a blog article (ideas / list type) in ${LANG[i.locale]}. ${RULES} ` +
      `Return one JSON object only: {"highlights":["", ...3 to 5 short bullet points a reader gets from this article],"intro_angle":"one sentence: how the introduction hooks the reader","items":[{"heading":"","angle":"one sentence: what makes this idea distinct"}],"faq":[{"question":""}, ...3 to 5 real reader questions],"conclusion_angle":"one sentence","meta_description":"the search-result description: ONE plain sentence of 110 to 150 characters that says what the reader gets, no quotes, no list numbers"}. ` +
      `"items" has EXACTLY ${i.n} entries, all different from each other (no near-duplicates), ordered for a reader, each heading a short specific name (max 70 characters) without the number in front. ` +
      `Cover the meaning of the main keyword and of its variants naturally; do not stuff them.`,
    prompt: `Title: ${i.title}\nMain keyword: ${i.keyword}\nVariants (same meaning): ${i.variants.length ? i.variants.join("; ") : "none"}\n${i.silo ? `Topic group: ${i.silo}\n` : ""}Number of list items: ${i.n}`,
  };
}

export function outlineSchema(n: number) {
  return withKeys(
    ["highlights", "intro_angle", "items", "faq", "conclusion_angle", "meta_description"],
    z.object({
      highlights: z.array(z.unknown()).transform((xs) => xs.flatMap((x) => (typeof x === "string" && x.trim() ? [x.trim().slice(0, 160)] : []))).refine((a) => a.length >= 2, { message: "highlights" }).transform((a) => a.slice(0, 6)),
      intro_angle: text(300),
      items: z
        .array(withKeys(["angle"], z.object({ heading: z.string().trim().min(2).max(120), angle: text(300) })))
        .refine((a) => a.length === n, { message: "item count" }),
      faq: z
        .array(withKeys([], z.object({ question: z.string().trim().min(5).max(200) })))
        .refine((a) => a.length >= 2, { message: "faq" })
        .transform((a) => a.slice(0, 5)),
      conclusion_angle: text(300),
      meta_description: text(220),
    }),
  );
}
export type Outline = z.output<ReturnType<typeof outlineSchema>>;

/** What is stored in articles.outline and read back by the section jobs (re-validated, never trusted). */
export const storedOutlineSchema = z.object({
  n: z.number().int().min(1).max(100),
  highlights: z.array(z.string()),
  intro_angle: z.string(),
  items: z.array(z.object({ heading: z.string(), angle: z.string() })),
  faq: z.array(z.object({ question: z.string() })),
  conclusion_angle: z.string(),
  meta_description: z.string().optional(),
});
export type StoredOutline = z.infer<typeof storedOutlineSchema>;

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------
type Ctx = { title: string; keyword: string; locale: Locale };
const outlineBrief = (o: StoredOutline) => o.items.map((x, k) => `${k + 1}. ${x.heading}`).join("\n");

export function introPrompt(c: Ctx, o: StoredOutline): { system: string; prompt: string } {
  return {
    system: `You write the introduction of a blog article in ${LANG[c.locale]}. ${RULES} Return one JSON object only: {"intro":["paragraph", ...2 or 3 paragraphs of 40 to 70 words]}. Hook the reader, say what the article covers and who it helps. Do not list the items.`,
    prompt: `Title: ${c.title}\nMain keyword: ${c.keyword}\nAngle: ${o.intro_angle}\nThe article lists ${o.n} ideas:\n${outlineBrief(o)}`,
  };
}
export const introSchema = withKeys(["intro"], z.object({ intro: paragraphs(1, 3, 900) }));

export function itemsPrompt(c: Ctx, o: StoredOutline, from: number, to: number, perItem: number): { system: string; prompt: string } {
  const mine = o.items.slice(from, to);
  return {
    system:
      `You write list items of a blog article in ${LANG[c.locale]}. ${RULES} ` +
      `For each requested item write about ${perItem} words as 1 or 2 paragraphs, plus optionally 2 to 4 short bullets (practical tips). Each item is a distinct idea: do not repeat what other items say. Do not number or title the item inside the text. ` +
      `Return one JSON object only: {"results":[{"i":<item number as given>,"paragraphs":["",...],"bullets":["",...]}]} with one entry per requested item.`,
    prompt: `Article: ${c.title}\nMain keyword: ${c.keyword}\nAll items (for context, do not overlap):\n${outlineBrief(o)}\n\nWrite ONLY these items:\n${mine.map((x, k) => `${from + k + 1}. ${x.heading} — ${x.angle}`).join("\n")}`,
  };
}
export const itemsSchema = tolerantList(
  withKeys(["bullets"], z.object({
    i: z.coerce.number().int().min(1).max(100),
    paragraphs: paragraphs(1, 3, 1400),
    bullets: z.unknown().transform((v) => (Array.isArray(v) ? v.flatMap((x) => (typeof x === "string" && x.trim() ? [x.trim().slice(0, 240)] : [])).slice(0, 5) : [])),
  })),
);

export function faqPrompt(c: Ctx, o: StoredOutline): { system: string; prompt: string } {
  return {
    system:
      `You write the FAQ and the conclusion of a blog article in ${LANG[c.locale]}. ${RULES} ` +
      `Answer each question in 30 to 60 words, practically and honestly. The conclusion is 1 or 2 short paragraphs (40 to 70 words in total) that close the article without repeating the list. ` +
      `Return one JSON object only: {"faq":[{"question":"","answer":""}],"conclusion":["",...]} — same questions, same order.`,
    prompt: `Article: ${c.title}\nMain keyword: ${c.keyword}\nConclusion angle: ${o.conclusion_angle}\nQuestions:\n${o.faq.map((q, k) => `${k + 1}. ${q.question}`).join("\n")}`,
  };
}
export const faqSchema = withKeys(
  ["faq", "conclusion"],
  z.object({
    faq: z.array(withKeys([], z.object({ question: z.string().trim().min(3).max(240), answer: z.string().trim().min(10).max(900) }))).refine((a) => a.length >= 1, { message: "faq" }),
    conclusion: paragraphs(1, 2, 700),
  }),
);

// stored shapes of article_sections.content
export type IntroContent = { paragraphs: string[] };
export type ItemContent = { heading: string; paragraphs: string[]; bullets: string[] };
export type FaqContent = { items: { question: string; answer: string }[] };
export type ConclusionContent = { paragraphs: string[] };
