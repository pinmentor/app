import { z } from "zod";
import { shortText, tolerantList, withKeys } from "@/modules/topical-map/tolerant";
import type { ConclusionContent, FaqContent, IntroContent, ItemContent } from "./prompts";

/**
 * Translation gloss (PLAN §5.1 point 2): the article translated into English or Bengali, part by part, so the owner can
 * judge the meaning without reading Spanish. It is a literal-leaning aid, not a publishable translation. On demand, never automatic.
 */
export const GLOSS_LANGS = { en: "English", bn: "Bengali (Bangla)" } as const;
export type GlossLang = keyof typeof GLOSS_LANGS;
export const isGlossLang = (v: unknown): v is GlossLang => v === "en" || v === "bn";
export const GLOSS_ITEMS_PER_JOB = 6; // must match the chunk of 6 in article_gloss_request (0019)

/** Part names of an article with n items, exactly as article_gloss_request (0019) enqueues them. */
export function glossParts(n: number): string[] {
  const parts = ["head", "intro"];
  for (let i = 0; i < Math.ceil(n / GLOSS_ITEMS_PER_JOB); i++) parts.push(`items:${i * GLOSS_ITEMS_PER_JOB}`);
  parts.push("faq");
  return parts;
}
export const partPattern = /^(head|intro|faq|items:\d{1,3})$/;

/** Rows (kind, idx) a finished gloss of n items has: head, intro, n items, faq, conclusion. */
export const glossRowCount = (n: number) => n + 4;

const SYS = (lang: GlossLang) =>
  `You translate Spanish blog text into ${GLOSS_LANGS[lang]} for a publisher who cannot read Spanish and needs to judge what the text really says. ` +
  `Translate faithfully and fairly literally: keep the meaning, do not improve, shorten or add anything; where the Spanish is awkward, let the translation sound awkward too. ` +
  `Keep the same number and order of paragraphs and bullets. Return one JSON object only, as described.`;

const strs = (max: number) => z.unknown().transform((v) => (Array.isArray(v) ? v.flatMap((x) => (typeof x === "string" && x.trim() ? [x.trim().slice(0, max)] : [])) : []));

export function headPrompt(lang: GlossLang, title: string, highlights: string[]) {
  return { system: `${SYS(lang)} Shape: {"title":"","highlights":["",...]}.`, prompt: JSON.stringify({ title, highlights }) };
}
export const headSchema = withKeys(["title", "highlights"], z.object({ title: z.unknown().transform(shortText(300)), highlights: strs(300) }));

export function paragraphsPrompt(lang: GlossLang, paragraphs: string[]) {
  return { system: `${SYS(lang)} Shape: {"paragraphs":["",...]}.`, prompt: JSON.stringify({ paragraphs }) };
}
export const paragraphsSchema = withKeys(["paragraphs"], z.object({ paragraphs: strs(2000).refine((a) => a.length > 0, { message: "empty" }) }));

export function itemsPrompt(lang: GlossLang, items: { i: number; content: ItemContent }[]) {
  return {
    system: `${SYS(lang)} Shape: {"results":[{"i":<item number as given>,"heading":"","paragraphs":["",...],"bullets":["",...]}]} with one entry per item.`,
    prompt: JSON.stringify(items.map((x) => ({ i: x.i, heading: x.content.heading, paragraphs: x.content.paragraphs, bullets: x.content.bullets }))),
  };
}
export const itemsSchema = tolerantList(
  withKeys(["bullets", "heading"], z.object({
    i: z.coerce.number().int().min(1).max(100),
    heading: z.unknown().transform(shortText(300)),
    paragraphs: strs(2000).refine((a) => a.length > 0, { message: "empty" }),
    bullets: strs(400),
  })),
);

export function faqPrompt(lang: GlossLang, faq: FaqContent, conclusion: ConclusionContent) {
  return {
    system: `${SYS(lang)} Shape: {"faq":[{"question":"","answer":""}],"conclusion":["",...]} with the same questions in the same order.`,
    prompt: JSON.stringify({ faq: faq.items, conclusion: conclusion.paragraphs }),
  };
}
export const faqSchema = withKeys(["faq", "conclusion"], z.object({
  faq: z.array(withKeys([], z.object({ question: z.unknown().transform(shortText(400)), answer: z.unknown().transform(shortText(1500)) }))).refine((a) => a.length > 0, { message: "faq" }),
  conclusion: strs(1500).refine((a) => a.length > 0, { message: "conclusion" }),
}));

export type GlossHead = { title: string; highlights: string[] };
export type GlossItem = { heading: string; paragraphs: string[]; bullets: string[] };
export type GlossFaq = { items: { question: string; answer: string }[] };
export type { IntroContent, ConclusionContent };
