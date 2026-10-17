import { GENERIC, PHRASES_ES, STOPWORDS_ES, synonymsFor, type Locale } from "./lexicon";

/** Lowercase, strip diacritics (ñ -> n), drop punctuation. For MATCHING only: display text keeps its accents. */
export function fold(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Light plural stripping (peinados -> peinado, mujeres -> mujer). Gender is kept on purpose: ninas != ninos. */
export function singularize(word: string): string {
  if (word.length <= 3 || /^\d+$/.test(word)) return word;
  // -es only when the singular ends in r/l/n/d/z/j (mujeres -> mujer, faciles -> facil); otherwise just drop the s
  // (bebes -> bebe, cortes -> corte, scrunchies -> scrunchie).
  if (word.endsWith("es") && word.length > 4 && "rlndzj".includes(word[word.length - 3] ?? "-")) return word.slice(0, -2);
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

export type Normalized = {
  /** Folded text after phrase rewrites. */
  folded: string;
  /** Canonical tokens, stopwords removed, order kept. */
  tokens: string[];
  /** Tokens before stopword removal (needed to read con/sin). */
  rawTokens: string[];
  /** Order-independent exact-match key. */
  key: string;
};

export function normalize(raw: string, locale: Locale = "es-MX"): Normalized {
  const syn = synonymsFor(locale);
  let folded = fold(raw);
  for (const [re, to] of PHRASES_ES) folded = folded.replace(re, to);
  const rawTokens = folded.split(" ").filter(Boolean);
  const canon = (w: string) => {
    const s = singularize(w);
    // also try the plain s-strip so simples -> simple finds its synonym even though the -es rule gave "simpl"
    const plain = w.endsWith("s") ? w.slice(0, -1) : w;
    return syn[s] ?? syn[plain] ?? syn[w] ?? s;
  };
  const tokens = rawTokens.filter((w) => !STOPWORDS_ES.has(w)).map(canon);
  const key = [...new Set(tokens)].sort().join(" ");
  return { folded, tokens, rawTokens: rawTokens.map(canon), key };
}

/** Tokens that carry meaning for comparison: generic words ignored. */
export function contentTokens(n: Normalized): Set<string> {
  return new Set(n.tokens.filter((t) => !GENERIC.has(t)));
}
