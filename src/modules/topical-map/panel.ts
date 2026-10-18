import { z } from "zod";
import type { Verdict } from "./compare";
import { verdictSchema } from "./schemas";

/**
 * Gold-set labelling protocol (PLAN §3.10): two independent models (different providers) label every pair.
 *  - they agree             -> confirmed label
 *  - they disagree + SERP   -> the SERP overlap decides (same page / different page), else uncertain
 *  - they disagree, no SERP -> `uncertain` (kept out of the metrics: never labelled by guessing)
 * This is "LLM-panel agreement", not native-speaker truth; the file says so in `labeledBy`.
 */
export type PanelLabel = Verdict | "uncertain";

export function reconcile(a: Verdict, b: Verdict, serp?: { common: number } | null): { label: PanelLabel; basis: "panel_agree" | "serp" | "unresolved" } {
  if (a === b) return { label: a, basis: "panel_agree" };
  if (serp) {
    if (serp.common >= 4) return { label: "same", basis: "serp" };
    if (serp.common <= 1) return { label: "different", basis: "serp" };
  }
  return { label: "uncertain", basis: "unresolved" };
}

export const labelResponseSchema = z.array(z.object({ i: z.number().int().min(0), verdict: verdictSchema, reason: z.string().max(300) }));

/** Deterministic dev/test assignment from the pair text, so re-running never moves a pair between splits. */
export function splitFor(a: string, b: string): "dev" | "test" {
  let h = 2166136261;
  for (const ch of `${a}\u0000${b}`) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 10 < 7 ? "dev" : "test";
}

export type PoolPair = { a: string; b: string; cosine: number };

/**
 * A balanced sample from a real run's pairs (PLAN §3.10 step 1): near (high cosine), borderline (middle) and clearly
 * different (low), taken evenly across the cosine range with a fixed stride, so the sample is reproducible.
 */
export function samplePairs(pool: PoolPair[], n: number): PoolPair[] {
  const sorted = [...pool].sort((x, y) => y.cosine - x.cosine || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  if (sorted.length <= n) return sorted;
  const step = sorted.length / n;
  return Array.from({ length: n }, (_, i) => sorted[Math.floor(i * step)]!);
}
