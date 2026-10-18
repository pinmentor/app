import { z } from "zod";
import { LIMITS } from "./stage-config";

/** Pure planning helpers for the map stages (no I/O): what to expand, how to chunk, when the coordinator advances. */

export const expansionTaskSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("value"), facetId: z.string().uuid(), facet: z.string().max(80), value: z.string().max(80) }),
  z.object({ kind: z.literal("questions") }),
]);
export type ExpansionTask = z.infer<typeof expansionTaskSchema>;

export type FacetWithValues = { id: string; name: string; values: string[] };

/**
 * How many LLM calls expand a map. Candidates should be 4-8x the final map (PLAN §3.4), each call yields up to
 * `candidatesPerCall`, so calls ~ target x overshoot / perCall, bounded. One call goes to question mining.
 */
export function expansionCallCount(targetMax: number): number {
  const n = Math.ceil((targetMax * LIMITS.overshoot) / LIMITS.candidatesPerCall);
  return Math.min(LIMITS.maxCalls, Math.max(LIMITS.minCalls, n));
}

/**
 * Facet values in round-robin order (value 1 of every facet, then value 2 of every facet, ...) so a small budget still
 * covers every dimension instead of exhausting the first facet. Never repeats a value: more calls than values is capped.
 */
export function planExpansion(facets: FacetWithValues[], targetMax: number): ExpansionTask[] {
  const wanted = expansionCallCount(targetMax) - 1; // one call is reserved for questions
  const tasks: ExpansionTask[] = [];
  const depth = Math.max(0, ...facets.map((f) => f.values.length));
  for (let r = 0; r < depth && tasks.length < wanted; r++) {
    for (const f of facets) {
      const value = f.values[r];
      if (value === undefined) continue;
      tasks.push({ kind: "value", facetId: f.id, facet: f.name, value });
      if (tasks.length >= wanted) break;
    }
  }
  tasks.push({ kind: "questions" });
  return tasks;
}

export function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** [0,total) cut into {from,to} ranges (to exclusive). */
export function ranges(total: number, size: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (let from = 0; from < total; from += size) out.push({ from, to: Math.min(from + size, total) });
  return out;
}

export type StageCounts = { queued: number; running: number; succeeded: number; dead: number };
export type AdvanceDecision = { action: "wait" } | { action: "go" } | { action: "fail"; reason: string };

/**
 * The coordinator polls instead of reacting to "last job finished" events: two jobs finishing at the same instant
 * would each see the other still running and nobody would advance. Polling is race-free and idempotent.
 */
export function decideAdvance(step: string, c: StageCounts, poll: number): AdvanceDecision {
  if (c.dead > 0) return { action: "fail", reason: `${step} stage failed` };
  if (c.queued + c.running > 0) {
    return poll >= LIMITS.advanceMaxPolls ? { action: "fail", reason: `${step} stage timed out` } : { action: "wait" };
  }
  return { action: "go" };
}

/** Judge jobs for `pending` pairs: about one LLM call each, never more than 60 parallel slots. */
export function judgeSlots(pending: number): number {
  return Math.min(60, Math.max(1, Math.ceil(pending / (LIMITS.judgePerJob * 0.8))));
}

/** Vectors from two different embedding models are not comparable: a run must be embedded by exactly one model. */
export function embeddingModelCheck(models: (string | null | undefined)[]): { ok: true; model: string | null } | { ok: false; reason: string } {
  const distinct = [...new Set(models.filter((m): m is string => typeof m === "string" && m.length > 0))];
  if (distinct.length > 1) return { ok: false, reason: "embedding chunks used different models" };
  return { ok: true, model: distinct[0] ?? null };
}
