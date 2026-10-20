import { z } from "zod";

/**
 * Stage timing of a map run, from map_runs.stats.timeline (written by map_run_set_stage). Pure: the run page and the
 * tests both use it. The run starts in s1_facets, which is not in the timeline, so the first stage runs from `createdAt`.
 */
const entrySchema = z.object({ stage: z.string(), at: z.string() });
export type StageTime = { stage: string; seconds: number | null };

export function stageDurations(createdAt: string, timeline: unknown, finishedAt: string | null): StageTime[] {
  const parsed = z.array(entrySchema).safeParse(timeline);
  const entries = parsed.success ? parsed.data : [];
  const stamps = [{ stage: "s1_facets", at: createdAt }, ...entries].map((e) => ({ stage: e.stage, ms: Date.parse(e.at) })).filter((e) => Number.isFinite(e.ms));
  const end = finishedAt ? Date.parse(finishedAt) : Number.NaN;
  return stamps.map((e, i) => {
    const next = stamps[i + 1]?.ms ?? end;
    return { stage: e.stage, seconds: Number.isFinite(next) ? Math.max(0, Math.round((next - e.ms) / 1000)) : null };
  });
}

/** 75 -> "1:15", 5 -> "0:05", null -> "running". */
export function formatSeconds(s: number | null): string {
  if (s === null) return "running";
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function totalSeconds(createdAt: string, finishedAt: string | null): number | null {
  const a = Date.parse(createdAt);
  const b = finishedAt ? Date.parse(finishedAt) : Number.NaN;
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 1000)) : null;
}
