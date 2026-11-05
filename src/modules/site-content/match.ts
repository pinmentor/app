import { contentTokens, normalize } from "@/modules/topical-map/normalize";
import type { Locale } from "@/modules/topical-map/lexicon";

/**
 * V6: does the website already have a page about a map keyword? Deterministic, no model, no credits.
 *  same  -> a page whose title, h1 or address slug has the same content words as the keyword (ignoring case, accents, plural, order)
 *  close -> the keyword's words are all in a page's title/h1/slug and the page adds at most 2 more, or the overlap is >= 75%
 * Headings are not used for the decision (an old long page often has a heading on many topics). A page needs >= 2 content words
 * to be compared, so a one-word title cannot swallow a whole topic.
 */
export type SiteDoc = { url: string; title: string | null; h1: string | null };
export type Existing = { kind: "same" | "close"; url: string; title: string | null; via: "title" | "h1" | "url" };

// all = every word that survives normalising (stopwords out, plural folded); content = all without the niche's generic words (peinado, idea, ...)
type Toks = { all: Set<string>; content: Set<string> };
const tokens = (text: string, locale: Locale): Toks => {
  const n = normalize(text, locale);
  return { all: new Set(n.tokens), content: contentTokens(n) };
};
const none: Toks = { all: new Set(), content: new Set() };

function slugText(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(last).replace(/[-_]+/g, " ").replace(/\.\w+$/, "");
  } catch {
    return "";
  }
}

export function compareToks(a: Toks, b: Toks): "same" | "close" | null {
  if (a.all.size >= 2 && a.all.size === b.all.size && [...a.all].every((x) => b.all.has(x))) return "same";
  return compareTokens(a.content, b.content);
}

export function compareTokens(a: Set<string>, b: Set<string>): "same" | "close" | null {
  if (a.size < 2 || b.size < 2) return null;
  let common = 0;
  for (const x of a) if (b.has(x)) common++;
  if (common === a.size && common === b.size) return "same";
  const union = a.size + b.size - common;
  if (common === a.size && b.size - a.size <= 2) return "close";
  if (common / union >= 0.75) return "close";
  return null;
}

/** Index once per map (one pass over the site's pages), then ask per keyword. */
export function buildIndex(docs: SiteDoc[], locale: Locale) {
  const rows = docs.map((d) => ({
    d,
    forms: [
      ["title", d.title ? tokens(d.title, locale) : none],
      ["h1", d.h1 ? tokens(d.h1, locale) : none],
      ["url", tokens(slugText(d.url), locale)],
    ] as const,
  }));
  return (keyword: string): Existing | null => {
    const k = tokens(keyword, locale);
    let best: Existing | null = null;
    for (const r of rows) {
      for (const [via, t] of r.forms) {
        const v = compareToks(k, t);
        if (!v) continue;
        const cand: Existing = { kind: v, url: r.d.url, title: r.d.title ?? r.d.h1, via };
        if (v === "same") return cand;
        best ??= cand;
      }
    }
    return best;
  };
}
