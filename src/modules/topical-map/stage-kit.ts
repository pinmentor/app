import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { JobError, type JobContext } from "@/modules/jobs/types";
import { chunk, type StageCounts } from "./plan";

/** Shared plumbing of the map stage handlers (S1-S9): admin client, payload parsing, live-run check, job enqueueing, paged reads. */

export const db = () => createAdminClient();

export const uuid = z.string().uuid();
export const basePayload = z.object({ mapRunId: uuid });

export const LOCALES = ["es-MX", "es-US", "es-ES", "en-US"] as const;
export const runSchema = z.object({
  id: uuid,
  workspace_id: uuid,
  topic: z.string(),
  language: z.string(),
  locale: z.enum(LOCALES),
  target_min: z.number().int(),
  target_max: z.number().int(),
  status: z.string(),
  params: z.unknown(),
});
export type Run = z.infer<typeof runSchema>;

/** `auto` = the topic decides its own size and target_max is only a ceiling; anything else = custom (min and max are targets). */
export function isAutoSize(params: unknown): boolean {
  return typeof params === "object" && params !== null && (params as Record<string, unknown>).size === "auto";
}

export function parsePayload<S extends z.ZodType>(schema: S, payload: unknown): z.output<S> {
  const p = schema.safeParse(payload);
  if (!p.success) throw new JobError("invalid payload", "invalid_payload", { retryable: false });
  return p.data;
}

/** The run, or null when it is no longer live (canceled/failed/finished) or not in this workspace. */
export async function liveRun(ctx: JobContext, runId: string): Promise<Run | null> {
  const { data, error } = await db()
    .from("map_runs")
    .select("id, workspace_id, topic, language, locale, target_min, target_max, status, params")
    .eq("id", runId)
    .eq("workspace_id", ctx.workspaceId)
    .maybeSingle();
  if (error) throw new JobError("run lookup failed", "db_error", { retryable: true });
  if (!data) throw new JobError("run not found", "run_not_found", { retryable: false });
  const run = runSchema.safeParse(data);
  if (!run.success) throw new JobError("run row invalid", "db_invalid_row", { retryable: false });
  return run.data.status === "queued" || run.data.status === "running" ? run.data : null;
}

export async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await db().rpc(name, args);
  if (error) throw new JobError(`${name} failed`, "db_error", { retryable: true });
  return data;
}

export async function enqueue(
  ctx: JobContext,
  type: string,
  payload: Record<string, unknown>,
  key: string,
  opts: { provider?: "anthropic" | "openai" | "gemini"; delaySeconds?: number; stage?: string } = {},
): Promise<void> {
  await rpc("job_enqueue", {
    p_workspace: ctx.workspaceId,
    p_type: type,
    p_payload: payload,
    p_key: key,
    p_credit_action: null,
    p_run_at: new Date(Date.now() + (opts.delaySeconds ?? 0) * 1000).toISOString(),
    p_max_attempts: 3,
    p_priority: 0,
    p_provider: opts.provider ?? null,
    p_parent: ctx.jobId,
    p_stage: opts.stage ?? null,
  });
}

export type AdvanceAfter = "s2" | "embed" | "pairs" | "judge" | "classify" | "titles";

export const advanceKey = (run: string, after: string, round: number, poll: number) => `map:${run}:adv:${after}:${round}:${poll}`;

export async function enqueueAdvance(ctx: JobContext, runId: string, after: AdvanceAfter, round: number, poll: number, delay: number) {
  await enqueue(ctx, "map.advance", { mapRunId: runId, after, round, poll }, advanceKey(runId, after, round, poll), { delaySeconds: delay });
}

/** Reads every row of a query, 1000 at a time (PostgREST page size), in a stable order. */
export async function readAll<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>, max = 20_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await fetchPage(from, from + 999);
    if (error) throw new JobError("db read failed", "db_error", { retryable: true });
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

export const candRow = z.object({ id: uuid, raw: z.string(), norm_key: z.string().nullable().optional(), status: z.string(), seq: z.number().int().nullable().optional(), merged_into: uuid.nullable().optional() });
export type CandRow = z.infer<typeof candRow>;

export async function loadCandidates(runId: string, statuses?: string[]): Promise<CandRow[]> {
  const rows = await readAll<unknown>((from, to) => {
    let q = db().from("kw_candidates").select("id, raw, norm_key, status, seq, merged_into").eq("map_run_id", runId);
    if (statuses) q = q.in("status", statuses);
    return q.order("id").range(from, to);
  });
  return rows.map((r) => {
    const p = candRow.safeParse(r);
    if (!p.success) throw new JobError("candidate row invalid", "db_invalid_row", { retryable: false });
    return p.data;
  });
}

export async function applyUpdates(runId: string, items: Record<string, unknown>[]): Promise<void> {
  for (const part of chunk(items, 500)) await rpc("kw_apply_updates", { p_run: runId, p_items: part });
}

export async function failRun(runId: string, reason: string): Promise<void> {
  await rpc("map_run_finish", { p_run: runId, p_status: "failed", p_error: reason });
}

export async function setStage(runId: string, stage: string): Promise<void> {
  await rpc("map_run_set_stage", { p_run: runId, p_stage: stage });
}

export const countsRow = z.object({ queued: z.coerce.number(), running: z.coerce.number(), succeeded: z.coerce.number(), dead: z.coerce.number() });

export async function stageCounts(runId: string, type: string): Promise<StageCounts> {
  const rows = z.array(countsRow).parse(await rpc("map_stage_status", { p_run: runId, p_type: type }));
  return rows[0] ?? { queued: 0, running: 0, succeeded: 0, dead: 0 };
}
