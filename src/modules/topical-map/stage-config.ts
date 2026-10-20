import { z } from "zod";
import type { Thresholds } from "./compare";
import { DEFAULT_LIST_RANGE, type ListRange } from "./titles";

/**
 * PLACEHOLDER thresholds for the REAL embedding model. The plan's 0.88 / 0.6 were tuned for the offline lexical
 * baseline, not for text-embedding-3-small, and the real-embedding sweep (`pnpm eval:dedup --embedder live --sweep`)
 * has not been run yet. Until it has, auto-merge by cosine alone is made harder (0.92) and fewer pairs reach the
 * judge (0.65). A run can override them through map_runs.params.thresholds; the run's stats record what was used.
 */
export const REAL_EMBEDDER_THRESHOLDS: Thresholds = { high: 0.92, low: 0.65 };

export const LIMITS = {
  /** texts per embed job (and per kw_set_embeddings call) */
  embedChunk: 128,
  /** candidate rows (x side) per S4 pair job; the y side is every later row */
  pairsChunk: 200,
  /** PostgREST returns at most 1000 rows per call: page through kw_neighbors */
  pairsPageSize: 1000,
  pairsMaxPages: 20,
  /** borderline pairs kept per pair job (top by cosine). Bounds kw_pairs growth: it is a disk-limited free tier. */
  borderlinePerChunk: 300,
  /** borderline pairs sent to the judge per run (the rest stay separate articles: the safe default) */
  judgeCap: 1500,
  /** pairs one judge job handles = one LLM call (JUDGE_BATCH is 30) */
  judgePerJob: 30,
  judgeRounds: 3,
  /** coordinator poll */
  advancePollSeconds: 10,
  advanceMaxPolls: 720,
  /** expansion */
  candidatesPerCall: 30,
  overshoot: 6,
  minCalls: 6,
  maxCalls: 150,
  tasksPerJob: 3,
  /** S5: primaries classified per job (one LLM call) */
  classifyChunk: 40,
  /** S7: plan items titled per job (one LLM call) */
  titleChunk: 20,
  /** S6: silos named per LLM call */
  siloNameChunk: 10,
  /** S6: neighbour graph of the primaries: cosine floor, neighbours per item, page cap (1000 rows per page) */
  edgeMin: 0.5,
  edgeK: 12,
  edgePages: 30,
  /** S9: pairs per stratum audited by the independent model, items language-checked */
  auditSample: 15,
  qaSample: 40,
} as const;

const thresholdsSchema = z.object({ high: z.number().min(0.5).max(1), low: z.number().min(0).max(1) }).refine((t) => t.low < t.high);

/** Thresholds of a run: its own params when valid, else the placeholders above. */
export function thresholdsFor(params: unknown): Thresholds {
  const p = z.object({ thresholds: thresholdsSchema }).safeParse(params);
  return p.success ? p.data.thresholds : REAL_EMBEDDER_THRESHOLDS;
}

const listRangeSchema = z.object({ min: z.number().int().min(3).max(99), max: z.number().int().min(3).max(100) }).refine((r) => r.min <= r.max);

/** Type A list-number range of a run: its own params.list_range when valid, else the default (7-35). */
export function listRangeFor(params: unknown): ListRange {
  const p = z.object({ list_range: listRangeSchema }).safeParse(params);
  return p.success ? p.data.list_range : DEFAULT_LIST_RANGE;
}
