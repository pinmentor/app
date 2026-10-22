import type { Locale } from "@/modules/topical-map/lexicon";
import { countWords, plainText, type ArticleParts } from "./render";

/**
 * Mechanical QA of a written article (PLAN §5 QA gate, the checks that need no second model). Verdict: any fail -> fail,
 * else any flag -> flag, else pass. Not covered yet and therefore NOT claimed: language QA by a different model, translation
 * gloss, back-translation, fact grounding, image / link / schema checks, readability.
 */
export type QaStatus = "pass" | "flag" | "fail";
export type QaCheck = { id: string; status: QaStatus; summary: string };
export type QaReport = { verdict: QaStatus; checks: QaCheck[]; words: number };

const YEAR = /\b(19|20)\d{2}\b/;
const MONEY = /[$€£¥]|\b(pesos?|d[oó]lares?|euros?|usd|mxn|eur)\b/i;
const EXPERIENCE = /\b(yo prob[eé]|prob[eé] personalmente|en mi experiencia|lo prob[eé]|hemos probado|we tested|i tried|in my experience)\b/i;
const CLICHES = ["en el mundo de hoy", "sin lugar a dudas", "sin duda alguna", "en el acelerado mundo", "no cabe duda", "es importante destacar", "in today's world", "without a doubt", "it is important to note"];
const ENGLISH_WORDS = new Set(["the", "and", "with", "for", "this", "that", "your", "you", "are", "from", "have", "will"]);

export function englishShare(text: string): number {
  const words = text.toLowerCase().match(/[a-záéíóúñü]+/g) ?? [];
  if (words.length === 0) return 0;
  return words.filter((w) => ENGLISH_WORDS.has(w)).length / words.length;
}

export function qaArticle(a: ArticleParts, slug: string | null, n: number, targetWords: number): QaReport {
  const text = plainText(a);
  const words = countWords(text);
  const checks: QaCheck[] = [];
  const add = (id: string, status: QaStatus, summary: string) => checks.push({ id, status, summary });

  const empty = a.items.filter((i) => i.paragraphs.length === 0).length;
  add("items", a.items.length === n && empty === 0 ? "pass" : "fail", a.items.length === n && empty === 0 ? `${n} items, all with text` : `expected ${n} items with text, found ${a.items.length} (${empty} empty)`);
  add("h1", a.title.trim().length >= 8 ? "pass" : "fail", a.title.trim().length >= 8 ? "title present" : "title missing or too short");
  const ratio = words / Math.max(1, targetWords);
  add("length", ratio >= 0.7 && ratio <= 1.6 ? "pass" : "flag", `${words} words (target ${targetWords})`);
  add("price", MONEY.test(text) ? "fail" : "pass", MONEY.test(text) ? "price or currency wording found" : "no price or currency wording");
  const yearInSlug = slug !== null && YEAR.test(slug);
  add("year_slug", yearInSlug || YEAR.test(a.title) ? "fail" : "pass", yearInSlug || YEAR.test(a.title) ? "a year in the title or slug" : "no year in title or slug");
  add("year_body", YEAR.test(text) ? "flag" : "pass", YEAR.test(text) ? "a year appears in the text" : "no year in the text");
  add("experience", EXPERIENCE.test(text) ? "flag" : "pass", EXPERIENCE.test(text) ? "first-person testing / experience claim" : "no invented experience claims");
  const lower = text.toLowerCase();
  const hits = CLICHES.filter((c) => lower.includes(c));
  add("cliches", hits.length ? "flag" : "pass", hits.length ? `stock phrases: ${hits.join(", ")}` : "no stock phrases from the ban list");
  const share = englishShare(text);
  const spanish = a.locale.startsWith("es");
  add("language_leak", spanish && share > 0.04 ? "flag" : "pass", spanish ? `English words ${(share * 100).toFixed(1)}% of the text` : "not checked for this language");

  const verdict: QaStatus = checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "flag") ? "flag" : "pass";
  return { verdict, checks, words };
}

export type { Locale };
