import { cosine } from "./embed";
import { conflict, extractFacts } from "./modifiers";
import { contentTokens, normalize, type Normalized } from "./normalize";
import type { Locale } from "./lexicon";

export type Verdict = "same" | "parent_child" | "related" | "different";

export type Thresholds = {
  /** cosine at or above: treated as the same page when no rule objects. */
  high: number;
  /** cosine below: unrelated. Between low and high is borderline and goes to the intent judge. */
  low: number;
};

export type PairDecision = {
  verdict: Verdict;
  /** rule = decided by deterministic rules; cosine = by thresholds alone; judge = needs the intent judge */
  by: "exact" | "rule" | "cosine" | "needs_judge";
  reason: string;
  cosine: number;
};

function isStrictSubset(a: Set<string>, b: Set<string>): boolean {
  if (a.size >= b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/**
 * Deterministic part of S4, given the cosine of the two keywords. Order of checks matters:
 * 1. exact key match -> same
 * 2. a hard modifier conflict (ninas vs ninos, corto vs largo, 5 vs 10 minutos, con vs sin) -> different. This is a
 *    veto that no similarity score or judge can override, because embeddings are blind to exactly these words.
 * 3. one keyword's content strictly contains the other's -> parent_child (never auto-merged: the extra word is
 *    the reason a second page might exist)
 * 4. same content words -> same
 * 5. otherwise thresholds: >= high same, < low different, in between = borderline for the judge.
 */
export function decidePair(
  na: Normalized,
  nb: Normalized,
  cos: number,
  t: Thresholds,
): PairDecision {
  if (na.key === nb.key) return { verdict: "same", by: "exact", reason: "same normalized key", cosine: cos };

  const why = conflict(extractFacts(na), extractFacts(nb));
  if (why) return { verdict: "different", by: "rule", reason: why, cosine: cos };

  const ca = contentTokens(na);
  const cb = contentTokens(nb);
  if (sameSet(ca, cb)) return { verdict: "same", by: "rule", reason: "same content words", cosine: cos };
  if (cos >= t.low && (isStrictSubset(ca, cb) || isStrictSubset(cb, ca))) {
    return { verdict: "parent_child", by: "rule", reason: "one keyword adds modifiers to the other", cosine: cos };
  }

  if (cos >= t.high) return { verdict: "same", by: "cosine", reason: `cosine ${cos.toFixed(2)} >= ${t.high}`, cosine: cos };
  if (cos < t.low) return { verdict: "different", by: "cosine", reason: `cosine ${cos.toFixed(2)} < ${t.low}`, cosine: cos };
  return { verdict: "related", by: "needs_judge", reason: "borderline similarity", cosine: cos };
}

export function decideTexts(a: string, b: string, va: number[], vb: number[], t: Thresholds, locale: Locale = "es-MX") {
  return decidePair(normalize(a, locale), normalize(b, locale), cosine(va, vb), t);
}
