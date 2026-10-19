import { z } from "zod";
import { slugify } from "@/lib/slugify";
import type { Locale } from "./lexicon";
import { shortText, tolerantList } from "./tolerant";

/**
 * S8: titles, slugs (PLAN §3.8). Titles: 3 options per item; Type A carries a list number N chosen HERE (seeded
 * random, no repeat inside a silo, round numbers avoided) and the model must use exactly that N. Slugs: keyword-only,
 * never a year, unique per run.
 */

export type ListRange = { min: number; max: number };
export const DEFAULT_LIST_RANGE: ListRange = { min: 7, max: 35 };

/** mulberry32 over an FNV-1a seed: tiny, deterministic, good enough for spreading numbers. */
export function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  let t = h >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const isRound = (n: number) => n % 5 === 0;

/**
 * List numbers for the Type A items of ONE silo. Distinct inside the silo while the range allows it; round numbers
 * (multiples of 5) only when no other number is left. Same seed -> same numbers, so a retried job changes nothing.
 */
export function assignListCounts(count: number, range: ListRange, seed: string): number[] {
  if (count <= 0) return [];
  const rnd = seededRandom(seed);
  const all: number[] = [];
  for (let n = range.min; n <= range.max; n++) all.push(n);
  const shuffle = (xs: number[]) => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  };
  const pool = [...shuffle(all.filter((n) => !isRound(n))), ...shuffle(all.filter(isRound))];
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(pool[i % pool.length]!);
  return out;
}

/** Word target of an item: lists scale with their length, product pages get a fixed default (editable later). */
export function targetWords(type: "A" | "B", listCount: number | null): number {
  if (type === "B") return 1800;
  return Math.min(3000, Math.max(1200, 400 + (listCount ?? 10) * 80));
}

const LANG: Record<Locale, string> = { "es-MX": "Mexican Spanish", "es-US": "US Spanish", "es-ES": "Castilian Spanish", "en-US": "US English" };

export type TitleItem = { keyword: string; type: "A" | "B"; listCount: number | null };

export function titlePrompt(topic: string, locale: Locale, items: TitleItem[]): { system: string; prompt: string } {
  return {
    system: `You write blog titles in ${LANG[locale]} for a content planner. For each keyword give 3 distinct title options (max 70 characters each), natural and click-worthy, containing the keyword's meaning. Type A (ideas / lists): every title MUST contain the given number N written as digits (for example "Los 27 Mejores Peinados para Cabello Rizado") and no other number. Type B (product / comparison): no number at all. Never include a year, a price, a discount or a currency. Also give a one-line gloss of the keyword and of the first title in English and in Bengali, so a non-Spanish reader can follow. Return only JSON: [{"i":0,"titles":["","",""],"keyword_gloss_en":"","keyword_gloss_bn":"","title_gloss_en":"","title_gloss_bn":""}], one object per keyword, same order.`,
    prompt: `Topic: ${topic}\n${items.map((x, i) => `${i}. "${stripYears(x.keyword)}" | type ${x.type}${x.type === "A" && x.listCount ? ` | N=${x.listCount}` : ""}`).join("\n")}`,
  };
}

const gloss = z.unknown().transform(shortText(300));
export const titleResponseSchema = tolerantList(
  z.object({
    i: z.coerce.number().int().min(0),
    titles: z.array(z.unknown()).transform((ts) => ts.flatMap((x) => (typeof x === "string" && x.trim().length > 0 ? [x.trim()] : []))),
    keyword_gloss_en: gloss,
    keyword_gloss_bn: gloss,
    title_gloss_en: gloss,
    title_gloss_bn: gloss,
  }),
);

const YEAR = /\b(19|20)\d{2}\b/;
const MONEY = /[$€£¥]|\b(pesos?|d[oó]lares?|euros?|usd|mxn|eur)\b|\b\d+\s?%/i;
export const MAX_TITLE_LENGTH = 70;

/** Why a title option is unusable, or null. */
export function titleProblem(title: string, type: "A" | "B", listCount: number | null): string | null {
  if (title.length < 8) return "too_short";
  if (title.length > MAX_TITLE_LENGTH + 10) return "too_long";
  if (YEAR.test(title)) return "has_year";
  if (MONEY.test(title)) return "has_price";
  const numbers: string[] = title.match(/\b\d+\b/g) ?? [];
  if (type === "A") {
    if (listCount === null || !numbers.includes(String(listCount))) return "missing_list_number";
    if (numbers.some((n) => n !== String(listCount))) return "other_number";
  } else if (numbers.length > 0) {
    return "has_number";
  }
  return null;
}

/** A year never appears in a title or slug (CLAUDE.md): remove it from keywords before they reach a title. */
export function stripYears(s: string): string {
  return s.replace(/\b(19|20)\d{2}\b/g, " ").replace(/\s+/g, " ").trim();
}

const cap = (s: string) => (s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Last-resort title when the model gave no usable option: flagged `title_fallback` so the editor rewrites it. */
export function fallbackTitle(keyword: string, type: "A" | "B", listCount: number | null, locale: Locale): string {
  const kw = stripYears(keyword);
  if (type === "A" && listCount !== null) return locale === "en-US" ? `${listCount} Best ${cap(kw)} Ideas` : `${listCount} Ideas de ${cap(kw)}`;
  return cap(kw);
}

/** Usable options in order (max 3, no duplicates) or one flagged fallback. */
export function cleanTitles(options: string[], type: "A" | "B", listCount: number | null, keyword: string, locale: Locale): { options: string[]; fallback: boolean; dropped: string[] } {
  const seen = new Set<string>();
  const good: string[] = [];
  const dropped: string[] = [];
  for (const o of options) {
    const key = o.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const why = titleProblem(o, type, listCount);
    if (why) dropped.push(`${why}: ${o}`);
    else good.push(o);
  }
  if (good.length === 0) return { options: [fallbackTitle(keyword, type, listCount, locale)], fallback: true, dropped };
  return { options: good.slice(0, 3), fallback: false, dropped };
}

/**
 * Keyword-only slugs, unique inside the run. A clash gets -2, -3 ...; a year never survives (slugify strips it).
 * `taken` lets a retried or partial run keep slugs it already issued.
 */
export function buildSlugs(keywords: string[], lang: "es" | "en", taken: Set<string> = new Set()): string[] {
  const used = new Set(taken);
  return keywords.map((kw) => {
    const base = slugify(kw, { lang, maxLength: 70 }) || "item";
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);
    return slug;
  });
}
