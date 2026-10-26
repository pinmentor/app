import { z } from "zod";
import { LANG, RULES } from "@/modules/articles/prompts";
import { englishShare } from "@/modules/articles/qa";
import type { Locale } from "@/modules/topical-map/lexicon";
import { shortText, tolerantList, withKeys } from "@/modules/topical-map/tolerant";

/**
 * Pin texts (PLAN §8, texts only): one pin = one ANGLE on the article, written to make a different person click. Titles up to 100
 * characters, descriptions up to 500 (Pinterest limits). The model also gives a Bengali meaning of each pin (its own gloss, a reading
 * aid for the owner, not an independent check). Images and posting come later.
 */
export const TITLE_MAX = 100;
export const DESC_MAX = 500;
export const DEFAULT_PINS = 5;

export type PinArticle = { title: string; keyword: string; locale: Locale; meta: string | null; headings: string[]; highlights: string[] };

export function pinPrompt(a: PinArticle, count: number): { system: string; prompt: string } {
  return {
    system:
      `You write Pinterest pin texts in ${LANG[a.locale]} for ONE blog article. ${RULES} ` +
      `Write exactly ${count} pins, each with a clearly DIFFERENT angle (for example: quick tip, list teaser, problem and solution, inspiration, question, who it is for). ` +
      `Titles: 40 to 95 characters, specific, no clickbait, no ALL CAPS, never just the article title. Description: 150 to 400 characters, natural sentences that include the main keyword once, end with a soft call to read the article, no hashtags. ` +
      `"alt" describes in one sentence (max 200 characters) what a matching image would show. "keywords": 3 to 5 short search phrases. "gloss_bn": the title and description meaning in Bengali, 1 or 2 sentences. ` +
      `Return one JSON object only: {"pins":[{"angle":"2-4 words","title":"","description":"","alt":"","keywords":["",...],"gloss_bn":""}]}.`,
    prompt: `Article title: ${a.title}\nMain keyword: ${a.keyword}\n${a.meta ? `Summary: ${a.meta}\n` : ""}Key points:\n${a.highlights.map((h) => `- ${h}`).join("\n")}\nSections:\n${a.headings.map((h, k) => `${k + 1}. ${h}`).join("\n")}`,
  };
}

const list = (max: number) => z.unknown().transform((v) => (Array.isArray(v) ? v.flatMap((x) => (typeof x === "string" && x.trim() ? [x.trim().slice(0, 60)] : [])).slice(0, max) : []));

export const pinSchema = tolerantList(
  withKeys(["angle", "alt", "keywords", "gloss_bn"], z.object({
    angle: z.unknown().transform(shortText(80)),
    title: z.string().trim().min(5).max(160),
    description: z.string().trim().min(20).max(900),
    alt: z.unknown().transform(shortText(500)),
    keywords: list(6),
    gloss_bn: z.unknown().transform(shortText(1500)),
  })),
);
export type PinDraft = z.output<typeof pinSchema>[number];

// ---------------------------------------------------------------------------
// Mechanical checks (no AI): what can be known from the text alone
// ---------------------------------------------------------------------------
export type PinChecks = { status: "pass" | "flag"; notes: string[] };

const YEAR = /\b(19|20)\d{2}\b/;
const MONEY = /[$€£¥]|\b(pesos?|d[oó]lares?|euros?|usd|mxn|eur)\b/i;
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ ]/g, " ").replace(/\s+/g, " ").trim();
const words = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length > 2));
export function similarity(a: string, b: string): number {
  const x = words(a), y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/** Checks every pin; `before` = titles/descriptions of the pins above it in the set (so only the later of two near-copies is flagged). */
export function checkPins(pins: PinDraft[], articleTitle: string): PinChecks[] {
  return pins.map((p, i) => {
    const notes: string[] = [];
    const t = p.title.length, d = p.description.length;
    if (t > TITLE_MAX) notes.push(`title is ${t} characters (limit ${TITLE_MAX})`);
    else if (t < 30) notes.push(`title is short (${t} characters)`);
    if (d > DESC_MAX) notes.push(`description is ${d} characters (limit ${DESC_MAX})`);
    else if (d < 100) notes.push(`description is short (${d} characters)`);
    if (!p.alt.trim()) notes.push("no image description (alt)");
    const all = `${p.title} ${p.description} ${p.alt}`;
    if (MONEY.test(all)) notes.push("price or currency wording");
    if (YEAR.test(all)) notes.push("a year in the text");
    if (englishShare(all) > 0.04) notes.push("English words in a Spanish text");
    if (/#\w/.test(all)) notes.push("hashtag in the text");
    if (similarity(p.title, articleTitle) >= 0.8) notes.push("title is (almost) the article title");
    for (let k = 0; k < i; k++) {
      const o = pins[k]!;
      if (similarity(p.title, o.title) >= 0.7 || similarity(p.description, o.description) >= 0.7) { notes.push(`too similar to pin ${k + 1}`); break; }
    }
    return { status: notes.length ? "flag" : "pass", notes };
  });
}
