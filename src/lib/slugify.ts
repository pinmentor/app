/**
 * Keyword-only, kebab-case, ASCII slug. Never contains a year (19xx/20xx).
 * Per PLAN §0 / CLAUDE.md hard rule. Stopwords are removed per language.
 */
const STOPWORDS: Record<string, ReadonlySet<string>> = {
  es: new Set(["a", "al", "con", "de", "del", "el", "la", "las", "los", "en", "y", "o", "un", "una", "unos", "unas", "por", "que", "se", "su", "sus", "lo", "e", "u"]),
  en: new Set(["a", "an", "the", "of", "and", "or", "in", "on", "to", "at", "is", "are", "be", "that", "this", "it", "its"]),
};

// "para" is kept for es: it is meaningful in titles (e.g. "para niñas"); see tests.
const YEAR_RE = /^(19|20)\d{2}$/;

export type SlugifyOptions = { lang?: "es" | "en"; maxLength?: number; removeStopwords?: boolean };

export function slugify(input: string, opts: SlugifyOptions = {}): string {
  const { lang = "es", maxLength = 80, removeStopwords = true } = opts;
  const stop = STOPWORDS[lang] ?? new Set<string>();

  const ascii = input
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/ß/g, "ss")
    .replace(/[øØ]/g, "o")
    .toLowerCase();

  const tokens = ascii
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .filter((t) => !YEAR_RE.test(t));

  let kept = removeStopwords ? tokens.filter((t) => !stop.has(t)) : tokens;
  if (kept.length === 0) kept = tokens; // never return empty just because of stopwords

  let slug = kept.join("-");
  if (slug.length > maxLength) {
    slug = slug.slice(0, maxLength);
    const cut = slug.lastIndexOf("-");
    if (cut > 0) slug = slug.slice(0, cut);
  }
  return slug.replace(/^-+|-+$/g, "");
}
