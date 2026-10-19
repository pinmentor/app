import { z } from "zod";
import { JobError, type JobContext, type JobHandler } from "@/modules/jobs/types";
import { callLlm } from "@/modules/llm/client";
import { embedTexts } from "@/modules/llm/embed";
import { LlmError } from "@/modules/llm/errors";
import { decidePair } from "./compare";
import { assembleGroups, type PairLogEntry } from "./dedup";
import { expansionPrompt, facetModelSchema, facetPrompt, keywordListSchema, questionPrompt, toCandidates } from "./facets";
import { llmIntentJudge } from "./judge";
import type { Locale } from "./lexicon";
import { normalize } from "./normalize";
import {
  chunk, decideAdvance, embeddingModelCheck, expansionTaskSchema, judgeSlots, planExpansion, ranges, type ExpansionTask,
} from "./plan";
import { judgeResponseSchema, verdictSchema, type Candidate } from "./schemas";
import { LIMITS, thresholdsFor } from "./stage-config";
import { afterClassify, afterTitles, planHandlers, startPlan } from "./stages-plan";
import {
  applyUpdates, basePayload, db, enqueue, enqueueAdvance, failRun, liveRun, loadCandidates, parsePayload, readAll, rpc, setStage, stageCounts, uuid,
  type Run,
} from "./stage-kit";

/**
 * S1-S4 of the topical map as chunked, resumable jobs (PLAN §3.2, §12). Every handler:
 *  - re-checks that the run is still live (a canceled / failed run turns its queued jobs into no-ops),
 *  - is idempotent (inserts ignore duplicates, updates recompute the same values),
 *  - stays well under 60 s (one small LLM call group, one embed chunk, one pair chunk, one judge call).
 * Credits are held by the RUN (map_run_create) and committed/released by map_run_finish, never by stage jobs.
 *
 * NOT exercised against a real database or live providers in the sandbox: the pure parts (plan.ts, compare, assemble)
 * have unit tests; the SQL functions are tested in supabase/tests/rls_0008.sql. See docs/PROGRESS.md.
 */

const s2Payload = basePayload.extend({ tasks: z.array(expansionTaskSchema).min(1).max(10) });
const rangePayload = basePayload.extend({ from: z.number().int().min(0), to: z.number().int().min(1) });
const advancePayload = basePayload.extend({
  after: z.enum(["s2", "embed", "pairs", "judge", "classify", "titles"]),
  poll: z.number().int().min(0).default(0),
  round: z.number().int().min(0).default(0),
});
const judgePayload = basePayload.extend({ slot: z.number().int().min(0), slots: z.number().int().min(1), round: z.number().int().min(0) });



// ---------------------------------------------------------------------------------------------------------------------
// S1: facet model
// ---------------------------------------------------------------------------------------------------------------------
const s1: JobHandler = async (ctx) => {
  const { mapRunId } = parsePayload(basePayload, ctx.payload);
  const run = await liveRun(ctx, mapRunId);
  if (!run) return { skipped: "run_not_live" };
  await setStage(mapRunId, "s1_facets");

  const { system, prompt } = facetPrompt(run.topic, run.locale);
  const r = await callLlm({ task: "facet_generation", workspaceId: ctx.workspaceId, jobId: ctx.jobId, system, prompt, schema: facetModelSchema, maxOutputTokens: 4000, temperature: 0.3 });

  // idempotent on retry: S2 has not started yet, so the facet rows can simply be rebuilt
  const del = await db().from("facets").delete().eq("map_run_id", mapRunId);
  if (del.error) throw new JobError("facet reset failed", "db_error", { retryable: true });

  const facets: { id: string; name: string; values: string[] }[] = [];
  for (const f of r.data.facets) {
    const ins = await db().from("facets").insert({ workspace_id: ctx.workspaceId, map_run_id: mapRunId, name: f.name, kind: f.kind }).select("id").single();
    const id = z.object({ id: uuid }).safeParse(ins.data);
    if (ins.error || !id.success) throw new JobError("facet insert failed", "db_error", { retryable: true });
    const values = [...new Set(f.values.map((v) => v.trim()).filter(Boolean))];
    if (values.length > 0) {
      const v = await db().from("facets").insert(values.map((value) => ({ workspace_id: ctx.workspaceId, map_run_id: mapRunId, name: value, kind: f.kind, parent_id: id.data.id })));
      if (v.error) throw new JobError("facet value insert failed", "db_error", { retryable: true });
    }
    facets.push({ id: id.data.id, name: f.name, values });
  }

  const tasks = planExpansion(facets, run.target_max);
  const groups = chunk(tasks, LIMITS.tasksPerJob);
  for (const [i, group] of groups.entries()) {
    await enqueue(ctx, "map.s2_expand", { mapRunId, tasks: group }, `map:${mapRunId}:s2:${i}`, { provider: "anthropic", stage: "s2_expand" });
  }
  await setStage(mapRunId, "s2_expand");
  await enqueueAdvance(ctx, mapRunId, "s2", 0, 0, LIMITS.advancePollSeconds);
  return { facets: facets.length, expansion_calls: tasks.length, expansion_jobs: groups.length, model_key: r.modelKey, cost_usd: r.costUsd };
};

// ---------------------------------------------------------------------------------------------------------------------
// S2: candidate expansion (a few small LLM calls in parallel per job)
// ---------------------------------------------------------------------------------------------------------------------
async function expandOne(ctx: JobContext, run: Run, task: ExpansionTask): Promise<{ candidates: Candidate[]; facetId: string | null; cost: number }> {
  const p = task.kind === "value" ? expansionPrompt(run.topic, run.locale, task.facet, task.value) : questionPrompt(run.topic, run.locale);
  const r = await callLlm({ task: "keyword_generation", workspaceId: ctx.workspaceId, jobId: ctx.jobId, system: p.system, prompt: p.prompt, schema: keywordListSchema, maxOutputTokens: 1800, temperature: 0.7 });
  const candidates = toCandidates(r.data.keywords, task.kind === "value" ? { source: "facet_matrix", facet: task.facet } : { source: "questions" });
  return { candidates, facetId: task.kind === "value" ? task.facetId : null, cost: r.costUsd };
}

const s2: JobHandler = async (ctx) => {
  const { mapRunId, tasks } = parsePayload(s2Payload, ctx.payload);
  const run = await liveRun(ctx, mapRunId);
  if (!run) return { skipped: "run_not_live" };

  const results = await Promise.all(tasks.map((t) => expandOne(ctx, run, t)));
  const rows = results.flatMap((res) =>
    res.candidates.map((c) => ({
      workspace_id: ctx.workspaceId,
      map_run_id: mapRunId,
      raw: c.raw,
      raw_key: c.raw.toLowerCase().trim(),
      lang: run.language,
      source: c.source,
      facet_id: res.facetId,
    })),
  );
  for (const part of chunk(rows, 500)) {
    const ins = await db().from("kw_candidates").upsert(part, { onConflict: "map_run_id,raw_key", ignoreDuplicates: true });
    if (ins.error) throw new JobError("candidate insert failed", "db_error", { retryable: true });
  }
  return { tasks: tasks.length, candidates_offered: rows.length, cost_usd: results.reduce((n, r) => n + r.cost, 0) };
};

// ---------------------------------------------------------------------------------------------------------------------
// S3: normalise (exact normalized-key duplicates merge here; everything else goes on to embeddings)
// ---------------------------------------------------------------------------------------------------------------------
const s3: JobHandler = async (ctx) => {
  const { mapRunId } = parsePayload(basePayload, ctx.payload);
  const run = await liveRun(ctx, mapRunId);
  if (!run) return { skipped: "run_not_live" };
  await setStage(mapRunId, "s3_normalize");

  const rows = await loadCandidates(mapRunId);
  const byKey = new Map<string, { id: string; raw: string }[]>();
  for (const c of rows) {
    const key = normalize(c.raw, run.locale as Locale).key || c.raw.toLowerCase();
    byKey.set(key, [...(byKey.get(key) ?? []), { id: c.id, raw: c.raw }]);
  }
  const survivors: { id: string; raw: string; key: string }[] = [];
  const updates: Record<string, unknown>[] = [];
  for (const [key, members] of byKey) {
    // shortest phrase, then alphabetical: reproducible
    const sorted = [...members].sort((a, b) => a.raw.length - b.raw.length || a.raw.localeCompare(b.raw));
    const keep = sorted[0]!;
    survivors.push({ ...keep, key });
    for (const m of sorted.slice(1)) updates.push({ id: m.id, norm_key: key, status: "merged", merged_into: keep.id, merge_reason: "same normalized key" });
  }
  survivors.sort((a, b) => a.raw.localeCompare(b.raw) || a.id.localeCompare(b.id));
  survivors.forEach((s, seq) => updates.push({ id: s.id, norm_key: s.key, seq, status: "raw" }));
  await applyUpdates(mapRunId, updates);

  const slices = ranges(survivors.length, LIMITS.embedChunk);
  for (const { from, to } of slices) {
    await enqueue(ctx, "map.s3_embed", { mapRunId, from, to }, `map:${mapRunId}:embed:${from}`, { provider: "openai", stage: "s3_embed" });
  }
  await setStage(mapRunId, "s3_embed");
  await enqueueAdvance(ctx, mapRunId, "embed", 0, 0, 20);
  return { candidates: rows.length, survivors: survivors.length, exact_merged: rows.length - survivors.length, embed_jobs: slices.length };
};

// ---------------------------------------------------------------------------------------------------------------------
// S4a: embeddings
// ---------------------------------------------------------------------------------------------------------------------
const s3embed: JobHandler = async (ctx) => {
  const { mapRunId, from, to } = parsePayload(rangePayload, ctx.payload);
  const run = await liveRun(ctx, mapRunId);
  if (!run) return { skipped: "run_not_live" };

  const { data, error } = await db()
    .from("kw_candidates")
    .select("id, raw")
    .eq("map_run_id", mapRunId)
    .eq("status", "raw")
    .is("embedding", null)
    .gte("seq", from)
    .lt("seq", to)
    .order("seq");
  if (error) throw new JobError("candidate read failed", "db_error", { retryable: true });
  const rows = z.array(z.object({ id: uuid, raw: z.string() })).parse(data ?? []);
  if (rows.length === 0) return { embedded: 0 };

  const r = await embedTexts({ workspaceId: ctx.workspaceId, jobId: ctx.jobId, texts: rows.map((x) => x.raw) });
  await rpc("kw_set_embeddings", { p_run: mapRunId, p_items: rows.map((x, i) => ({ id: x.id, embedding: r.vectors[i] })) });
  return { embedded: rows.length, model_key: r.modelKey, cost_usd: r.costUsd };
};

// ---------------------------------------------------------------------------------------------------------------------
// S4b: candidate pairs (pgvector neighbours + deterministic rules)
// ---------------------------------------------------------------------------------------------------------------------
const neighborRow = z.object({ a: uuid, b: uuid, cosine: z.number() });

const s4pairs: JobHandler = async (ctx) => {
  const { mapRunId, from, to } = parsePayload(rangePayload, ctx.payload);
  const run = await liveRun(ctx, mapRunId);
  if (!run) return { skipped: "run_not_live" };
  const t = thresholdsFor(run.params);
  const locale = run.locale as Locale;

  const survivors = await loadCandidates(mapRunId, ["raw"]);
  const info = new Map(survivors.map((c) => [c.id, normalize(c.raw, locale)]));

  const found: { a: string; b: string; cosine: number }[] = [];
  for (let page = 0; page < LIMITS.pairsMaxPages; page++) {
    const { data, error } = await db()
      .rpc("kw_neighbors", { p_run: mapRunId, p_from: from, p_to: to, p_min: t.low })
      .range(page * LIMITS.pairsPageSize, (page + 1) * LIMITS.pairsPageSize - 1);
    if (error) throw new JobError("kw_neighbors failed", "db_error", { retryable: true });
    const rows = z.array(neighborRow).parse(data ?? []);
    found.push(...rows);
    if (rows.length < LIMITS.pairsPageSize) break;
  }

  const store: Record<string, unknown>[] = [];
  let borderline = 0;
  for (const n of found) {
    const na = info.get(n.a);
    const nb = info.get(n.b);
    if (!na || !nb) continue;
    const d = decidePair(na, nb, n.cosine, t);
    const [a, b] = n.a < n.b ? [n.a, n.b] : [n.b, n.a];
    const base = { map_run_id: mapRunId, workspace_id: ctx.workspaceId, a, b, cosine: n.cosine };
    if (d.by === "needs_judge") {
      if (borderline >= LIMITS.borderlinePerChunk) continue; // rows arrive highest cosine first: keep the likeliest
      borderline++;
      store.push({ ...base, verdict: null });
    } else if (d.verdict === "same" || d.verdict === "parent_child") {
      store.push({ ...base, verdict: d.verdict, judged_by: d.by, reason: d.reason });
    }
  }
  for (const part of chunk(store, 500)) {
    const ins = await db().from("kw_pairs").upsert(part, { onConflict: "map_run_id,a,b", ignoreDuplicates: true });
    if (ins.error) throw new JobError("pair insert failed", "db_error", { retryable: true });
  }
  return { neighbours: found.length, stored: store.length, borderline };
};

// ---------------------------------------------------------------------------------------------------------------------
// S4c: intent judge for borderline pairs
// ---------------------------------------------------------------------------------------------------------------------
const pendingRow = z.object({ a: uuid, b: uuid, a_raw: z.string(), b_raw: z.string() });

const s4judge: JobHandler = async (ctx) => {
  const { mapRunId, slot, slots } = parsePayload(judgePayload, ctx.payload);
  const run = await liveRun(ctx, mapRunId);
  if (!run) return { skipped: "run_not_live" };

  const rows = z.array(pendingRow).parse(await rpc("kw_pending_pairs", { p_run: mapRunId, p_slot: slot, p_slots: slots, p_limit: LIMITS.judgePerJob }));
  if (rows.length === 0) return { judged: 0 };

  let cost = 0;
  const providers = new Set<string>();
  const judge = llmIntentJudge(async (req) => {
    const r = await callLlm({ task: "intent_judge", workspaceId: ctx.workspaceId, jobId: ctx.jobId, system: req.system, prompt: req.prompt, schema: judgeResponseSchema, maxOutputTokens: 8000, temperature: 0 });
    cost += r.costUsd;
    providers.add(r.provider);
    return r.data;
  });
  const out = await judge.judge(rows.map((r) => ({ a: r.a_raw, b: r.b_raw })));

  for (const part of chunk(rows.map((r, i) => ({ r, o: out[i]! })), 10)) {
    await Promise.all(
      part.map(async ({ r, o }) => {
        const v = verdictSchema.parse(o.verdict);
        const upd = await db().from("kw_pairs").update({ verdict: v, judged_by: "judge", reason: o.reason.slice(0, 300) }).eq("map_run_id", mapRunId).eq("a", r.a).eq("b", r.b);
        if (upd.error) throw new JobError("verdict update failed", "db_error", { retryable: true });
      }),
    );
  }
  return { judged: rows.length, cost_usd: cost, providers: [...providers] };
};

// ---------------------------------------------------------------------------------------------------------------------
// Coordinator: polls a stage, then enqueues the next one
// ---------------------------------------------------------------------------------------------------------------------
const STAGE_TYPE = { s2: "map.s2_expand", embed: "map.s3_embed", pairs: "map.s4_pairs", judge: "map.s4_judge", classify: "map.s5_classify", titles: "map.s7_titles" } as const;

async function pendingPairCount(runId: string): Promise<number> {
  const { count, error } = await db().from("kw_pairs").select("*", { count: "exact", head: true }).eq("map_run_id", runId).is("verdict", null);
  if (error) throw new JobError("pending count failed", "db_error", { retryable: true });
  return count ?? 0;
}

async function enqueueJudgeRound(ctx: JobContext, runId: string, round: number, pending: number): Promise<void> {
  const slots = judgeSlots(pending);
  for (let slot = 0; slot < slots; slot++) {
    await enqueue(ctx, "map.s4_judge", { mapRunId: runId, slot, slots, round }, `map:${runId}:judge:${round}:${slot}`, { provider: "anthropic", stage: "s4_judge" });
  }
  await enqueueAdvance(ctx, runId, "judge", round, 0, LIMITS.advancePollSeconds);
}

const advance: JobHandler = async (ctx) => {
  const { mapRunId, after, poll, round } = parsePayload(advancePayload, ctx.payload);
  const run = await liveRun(ctx, mapRunId);
  if (!run) return { skipped: "run_not_live" };

  // judge rounds are keyed by round: only that round's jobs count, which is why the counts below are per type for the run
  const decision = decideAdvance(after, await stageCounts(mapRunId, STAGE_TYPE[after]), poll);
  if (decision.action === "fail") {
    await failRun(mapRunId, decision.reason);
    return { failed: decision.reason };
  }
  if (decision.action === "wait") {
    await enqueueAdvance(ctx, mapRunId, after, round, poll + 1, LIMITS.advancePollSeconds);
    return { waiting: true, poll };
  }

  if (after === "s2") {
    await enqueue(ctx, "map.s3_normalize", { mapRunId }, `map:${mapRunId}:s3`, { stage: "s3_normalize" });
    return { next: "s3_normalize" };
  }

  if (after === "classify") {
    await afterClassify(ctx, mapRunId);
    return { next: "s6_silos" };
  }

  if (after === "titles") {
    await afterTitles(ctx, mapRunId);
    return { next: "s8_links" };
  }

  if (after === "embed") {
    const { data, error } = await db().from("jobs").select("result").eq("type", "map.s3_embed").contains("payload", { mapRunId });
    if (error) throw new JobError("embed results read failed", "db_error", { retryable: true });
    const models = (data ?? []).map((j: { result?: { model_key?: string } | null }) => j.result?.model_key ?? null);
    const check = embeddingModelCheck(models);
    if (!check.ok) {
      await failRun(mapRunId, check.reason);
      return { failed: check.reason };
    }
    const survivors = await loadCandidates(mapRunId, ["raw"]);
    const slices = ranges(survivors.length, LIMITS.pairsChunk);
    for (const { from, to } of slices) {
      await enqueue(ctx, "map.s4_pairs", { mapRunId, from, to }, `map:${mapRunId}:pairs:${from}`, { stage: "s4_pairs" });
    }
    await setStage(mapRunId, "s4_pairs");
    await enqueueAdvance(ctx, mapRunId, "pairs", 0, 0, 10);
    return { next: "s4_pairs", pair_jobs: slices.length, embedding_model: check.model };
  }

  if (after === "pairs") {
    const capped = z.number().parse(await rpc("kw_cap_pending", { p_run: mapRunId, p_keep: LIMITS.judgeCap }));
    const pending = await pendingPairCount(mapRunId);
    await setStage(mapRunId, "s4_judge");
    if (pending === 0) {
      await enqueue(ctx, "map.s4_finalize", { mapRunId }, `map:${mapRunId}:finalize`, { stage: "s4_finalize" });
      return { next: "s4_finalize", capped };
    }
    await enqueueJudgeRound(ctx, mapRunId, 0, pending);
    return { next: "s4_judge", pending, capped };
  }

  // after === "judge"
  const pending = await pendingPairCount(mapRunId);
  if (pending > 0 && round + 1 < LIMITS.judgeRounds) {
    await enqueueJudgeRound(ctx, mapRunId, round + 1, pending);
    return { next: "s4_judge", round: round + 1, pending };
  }
  if (pending > 0) await rpc("kw_cap_pending", { p_run: mapRunId, p_keep: 0 }); // leftovers stay separate articles
  await enqueue(ctx, "map.s4_finalize", { mapRunId }, `map:${mapRunId}:finalize`, { stage: "s4_finalize" });
  return { next: "s4_finalize", left_unjudged: pending };
};

// ---------------------------------------------------------------------------------------------------------------------
// S4d: finalize: groups -> primary + variants, free the vectors, commit the credits
// ---------------------------------------------------------------------------------------------------------------------
const pairRow = z.object({ a: uuid, b: uuid, verdict: verdictSchema, judged_by: z.string().nullable(), reason: z.string().nullable(), cosine: z.number().nullable() });

const s4finalize: JobHandler = async (ctx) => {
  const { mapRunId } = parsePayload(basePayload, ctx.payload);
  const run = await liveRun(ctx, mapRunId);
  if (!run) return { skipped: "run_not_live" };
  const locale = run.locale as Locale;

  const all = await loadCandidates(mapRunId);
  const survivors = all.filter((c) => c.status === "raw" || c.status === "primary");
  const index = new Map(survivors.map((c, i) => [c.id, i]));

  const pairRows = (
    await readAll<unknown>((from, to) =>
      db().from("kw_pairs").select("a, b, verdict, judged_by, reason, cosine").eq("map_run_id", mapRunId).in("verdict", ["same", "parent_child"]).order("a").order("b").range(from, to),
    )
  ).map((r) => pairRow.parse(r));

  const candidates: Candidate[] = survivors.map((c) => ({ raw: c.raw, source: "map" }));
  const same: [number, number][] = [];
  const parentChild: [number, number][] = [];
  const log: PairLogEntry[] = [];
  for (const p of pairRows) {
    const i = index.get(p.a);
    const j = index.get(p.b);
    if (i === undefined || j === undefined) continue;
    if (p.verdict === "same") same.push([i, j]);
    else parentChild.push([i, j]);
    log.push({ a: survivors[i]!.raw, b: survivors[j]!.raw, verdict: p.verdict, by: p.judged_by === "judge" ? "judge" : "rule", reason: p.reason ?? "", cosine: p.cosine ?? 0 });
  }

  const norm = survivors.map((c) => normalize(c.raw, locale));
  const result = assembleGroups(candidates, norm, { same, parentChild }, log);

  const idByRaw = new Map(survivors.map((c) => [c.raw, c.id]));
  const primaryOf = new Map<string, string>(); // survivor id -> final primary id
  const updates: Record<string, unknown>[] = [];
  for (const g of result.groups) {
    const pid = idByRaw.get(g.primary.raw)!;
    primaryOf.set(pid, pid);
    updates.push({ id: pid, status: "primary" });
    for (const v of g.variants) {
      const vid = idByRaw.get(v.raw)!;
      primaryOf.set(vid, pid);
      updates.push({ id: vid, status: "merged", merged_into: pid, merge_reason: g.reasons[0] ?? "same search intent" });
    }
  }
  // candidates merged in S3 pointed at their key-survivor; if that survivor became a variant, follow it to the primary
  for (const c of all) {
    if (c.status !== "merged" || !c.merged_into) continue;
    const target = primaryOf.get(c.merged_into);
    if (target && target !== c.merged_into) updates.push({ id: c.id, merged_into: target });
  }
  await applyUpdates(mapRunId, updates);

  const embedRes = await db().from("jobs").select("result").eq("type", "map.s3_embed").contains("payload", { mapRunId }).limit(1);
  const embeddingModel = ((embedRes.data ?? [])[0] as { result?: { model_key?: string } | null } | undefined)?.result?.model_key ?? null;
  const judgedBy = async (by: string) => {
    const { count } = await db().from("kw_pairs").select("*", { count: "exact", head: true }).eq("map_run_id", mapRunId).eq("judged_by", by);
    return count ?? 0;
  };
  const cost = z.coerce.number().parse(await rpc("map_run_cost_usd", { p_run: mapRunId }));
  const stats = {
    candidates_total: all.length,
    after_exact_merge: survivors.length,
    primaries: result.groups.length,
    merged_total: all.length - result.groups.length,
    parent_child_links: result.parentChild.length,
    pairs_judged: await judgedBy("judge"),
    pairs_over_judge_cap: await judgedBy("cap"),
    thresholds: thresholdsFor(run.params),
    embedding_model: embeddingModel,
    cost_usd: cost,
    target_min: run.target_min,
    target_max: run.target_max,
  };
  await rpc("map_run_drop_embeddings", { p_run: mapRunId });
  // The run is NOT finished here any more: S5-S9 follow, and S9 commits the credits (stages-plan.ts).
  await rpc("map_run_merge_stats", { p_run: mapRunId, p_stats: stats });
  const next = await startPlan(ctx, mapRunId);
  return { ...stats, next: "s5_classify", ...next };
};

export const mapHandlers: Record<string, JobHandler> = {
  "map.s1_facets": s1,
  "map.s2_expand": s2,
  "map.s3_normalize": s3,
  "map.s3_embed": s3embed,
  "map.s4_pairs": s4pairs,
  "map.s4_judge": s4judge,
  "map.advance": advance,
  "map.s4_finalize": s4finalize,
  ...planHandlers,
};

export { LlmError };
