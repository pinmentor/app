import { z } from "zod";
import { JobError, type JobContext, type JobHandler } from "@/modules/jobs/types";
import { callLlm } from "@/modules/llm/client";
import { LlmError } from "@/modules/llm/errors";
import { articleTypeFor, classificationFlags, classifyPrompt, classifyResponseSchema, cleanClassification, type Intent } from "./classify";
import { JUDGE_SYSTEM, buildJudgePrompt } from "./judge";
import type { Locale } from "./lexicon";
import { buildLinkPlans } from "./links";
import { chunk, ranges } from "./plan";
import { samplePairs } from "./panel";
import { judgeResponseSchema } from "./schemas";
import { scoreItem } from "./score";
import { clusterSilos, foldEdges, pickPillar, siloNameOrFallback, siloNamePrompt, siloNameResponseSchema, type Edge } from "./silo";
import { LIMITS, listRangeFor, thresholdsFor } from "./stage-config";
import { basePayload, db, enqueue, enqueueAdvance, failRun, liveRun, loadCandidates, parsePayload, readAll, rpc, setStage, uuid, type Run } from "./stage-kit";
import { assignListCounts, buildSlugs, cleanTitles, targetWords, titlePrompt, titleResponseSchema } from "./titles";
import {
  buildReport, checkAudit, checkCannibalization, checkCoverage, checkDuplicates, checkExistingContent, checkIntent, checkLanguage, checkPolicy, checkRules,
  checkSizeBalance, type Audit, type LangQa, type VItem, type VPair,
} from "./verify";

/**
 * S5-S9 of the topical map (PLAN §3.8, §3.9), chained after S4:
 *   S5 classify (fan-out, LLM) -> S6 silos + scoring + plan items (one job) -> S7 titles (fan-out, LLM)
 *   -> S8 slugs + link plan (one job) -> S9 verification report + snapshot + commit credits (one job).
 * Same rules as S1-S4: every handler re-checks that the run is live, is idempotent (S6 rebuilds the plan from scratch,
 * the others recompute the same values) and stays far below 60 s. Credits are held by the run and committed by S9.
 *
 * NOT exercised against a real database or live providers in the sandbox: the pure parts are unit-tested, the SQL
 * functions are tested in supabase/tests/rls_0010.sql. See docs/PROGRESS.md.
 */

const rangePayload = basePayload.extend({ from: z.number().int().min(0), to: z.number().int().min(1) });

// ---------------------------------------------------------------------------------------------------------------------
// Entry from S4 finalize
// ---------------------------------------------------------------------------------------------------------------------
/** Called by the S4 finalize job instead of finishing the run: fans out S5. */
export async function startPlan(ctx: JobContext, runId: string): Promise<{ primaries: number; jobs: number }> {
  const primaries = await loadCandidates(runId, ["primary"]);
  await setStage(runId, "s5_classify");
  const slices = ranges(primaries.length, LIMITS.classifyChunk);
  for (const { from, to } of slices) {
    await enqueue(ctx, "map.s5_classify", { mapRunId: runId, from, to }, `map:${runId}:s5:${from}`, { provider: "anthropic", stage: "s5_classify" });
  }
  await enqueueAdvance(ctx, runId, "classify", 0, 0, 10);
  return { primaries: primaries.length, jobs: slices.length };
}

/** Coordinator hooks: what follows a finished S5 / S7 fan-out. */
export async function afterClassify(ctx: JobContext, runId: string): Promise<void> {
  await enqueue(ctx, "map.s6_silos", { mapRunId: runId }, `map:${runId}:s6`, { stage: "s6_silos" });
}
export async function afterTitles(ctx: JobContext, runId: string): Promise<void> {
  await enqueue(ctx, "map.s8_links", { mapRunId: runId }, `map:${runId}:s8`, { stage: "s8_links" });
}

// ---------------------------------------------------------------------------------------------------------------------
// Shared reads
// ---------------------------------------------------------------------------------------------------------------------
const primaryRow = z.object({
  id: uuid,
  raw: z.string(),
  norm_key: z.string().nullable(),
  seq: z.number().int().nullable(),
  facet_id: uuid.nullable(),
  intent: z.string().nullable(),
  funnel: z.string().nullable(),
  demand_tier: z.number().nullable(),
  pinterest_fit: z.number().nullable(),
  seasonality: z.number().nullable(),
  comp_score: z.number().nullable(),
  flags: z.array(z.string()),
});
type Primary = z.infer<typeof primaryRow>;
const PRIMARY_COLS = "id, raw, norm_key, seq, facet_id, intent, funnel, demand_tier, pinterest_fit, seasonality, comp_score, flags";

async function loadPrimaries(runId: string): Promise<Primary[]> {
  const rows = await readAll<unknown>((from, to) => db().from("kw_candidates").select(PRIMARY_COLS).eq("map_run_id", runId).eq("status", "primary").order("seq").order("id").range(from, to));
  return rows.map((r) => {
    const p = primaryRow.safeParse(r);
    if (!p.success) throw new JobError("primary row invalid", "db_invalid_row", { retryable: false });
    return p.data;
  });
}

const edgeRow = z.object({ a: uuid, b: uuid, cosine: z.coerce.number() });
export type IdEdge = z.infer<typeof edgeRow>;

/** The neighbour graph of the primaries (kw_primary_edges), paged 1000 rows at a time with SQL-side offsets. */
async function loadEdges(runId: string): Promise<IdEdge[]> {
  const out: IdEdge[] = [];
  for (let page = 0; page < LIMITS.edgePages; page++) {
    const rows = z.array(edgeRow).parse(await rpc("kw_primary_edges", { p_run: runId, p_min: LIMITS.edgeMin, p_k: LIMITS.edgeK, p_offset: page * 1000, p_limit: 1000 }));
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const toEdges = (edges: IdEdge[], index: Map<string, number>): Edge[] =>
  foldEdges(
    index.size,
    edges.flatMap((e) => {
      const a = index.get(e.a);
      const b = index.get(e.b);
      return a === undefined || b === undefined ? [] : [{ a, b, sim: e.cosine }];
    }),
  );

async function projectOf(runId: string): Promise<string> {
  const { data, error } = await db().from("map_runs").select("project_id").eq("id", runId).single();
  const p = z.object({ project_id: uuid }).safeParse(data);
  if (error || !p.success) throw new JobError("project lookup failed", "db_error", { retryable: true });
  return p.data.project_id;
}

const langOf = (run: Run): "es" | "en" => (run.language.startsWith("es") ? "es" : "en");

// ---------------------------------------------------------------------------------------------------------------------
// S5: intent / funnel / demand estimate / pinterest fit
// ---------------------------------------------------------------------------------------------------------------------
const s5classify: JobHandler = async (ctx) => {
  const { mapRunId, from, to } = parsePayload(rangePayload, ctx.payload);
  const run = await liveRun(ctx, mapRunId);
  if (!run) return { skipped: "run_not_live" };

  const rows = z
    .array(z.object({ id: uuid, raw: z.string() }))
    .parse((await db().from("kw_candidates").select("id, raw").eq("map_run_id", mapRunId).eq("status", "primary").order("seq").order("id").range(from, to - 1)).data ?? []);
  if (rows.length === 0) return { classified: 0 };

  const p = classifyPrompt(run.topic, run.locale, rows.map((r) => r.raw));
  const r = await callLlm({ task: "intent_classification", workspaceId: ctx.workspaceId, jobId: ctx.jobId, system: p.system, prompt: p.prompt, schema: classifyResponseSchema, maxOutputTokens: 4000, temperature: 0 });
  const byIndex = new Map(r.data.map((x) => [x.i, x]));

  let missing = 0;
  const items = rows.map((row, i) => {
    const answer = byIndex.get(i);
    if (!answer) {
      missing++;
      return { id: row.id, flags: ["classification_missing"] };
    }
    const c = cleanClassification(answer);
    return { id: row.id, intent: c.intent, funnel: c.funnel, demand_tier: c.demandTier, pinterest_fit: c.pinterestFit, seasonality: c.seasonality, flags: classificationFlags(row.raw, c) };
  });
  await rpc("kw_apply_classification", { p_run: mapRunId, p_items: items });
  return { classified: rows.length - missing, missing, provider: r.provider, model_key: r.modelKey, cost_usd: r.costUsd };
};

// ---------------------------------------------------------------------------------------------------------------------
// S6: trim to target, silos, scoring, plan items
// ---------------------------------------------------------------------------------------------------------------------
type Scored = { p: Primary; intent: Intent; type: "A" | "B"; base: number };

const asIntent = (v: string | null): Intent => (v === "commercial_investigation" || v === "transactional" || v === "navigational" ? v : "informational");

function scoreOf(p: Primary, role: "pillar" | "supporting" | "unassigned") {
  const intent = asIntent(p.intent);
  const type = articleTypeFor(intent);
  return { intent, type, detail: scoreItem({ demandTier: p.demand_tier ?? 3, compScore: p.comp_score, articleType: type, intent, pinterestFit: p.pinterest_fit ?? 3, seasonality: p.seasonality ?? 0, siloRole: role }) };
}

const s6silos: JobHandler = async (ctx) => {
  const { mapRunId } = parsePayload(basePayload, ctx.payload);
  const run = await liveRun(ctx, mapRunId);
  if (!run) return { skipped: "run_not_live" };
  await setStage(mapRunId, "s6_silos");
  const projectId = await projectOf(mapRunId);
  const locale = run.locale as Locale;

  const primaries = await loadPrimaries(mapRunId);
  if (primaries.length === 0) {
    await failRun(mapRunId, "no primaries to plan");
    return { failed: "no_primaries" };
  }

  // 1) trim to the target maximum by base priority (lowest first out); dropped items stay in the table, status 'dropped'
  const scored: Scored[] = primaries.map((p) => {
    const s = scoreOf(p, "unassigned");
    return { p, intent: s.intent, type: s.type, base: s.detail.priority };
  });
  const ranked = [...scored].sort((x, y) => y.base - x.base || x.p.id.localeCompare(y.p.id));
  const kept = ranked.slice(0, run.target_max);
  const dropped = ranked.slice(run.target_max);
  if (dropped.length > 0) {
    for (const part of chunk(dropped.map((d) => ({ id: d.p.id, status: "dropped", merge_reason: "over target size (lower priority)" })), 500)) await rpc("kw_apply_updates", { p_run: mapRunId, p_items: part });
  }
  const keptSet = new Set(kept.map((k) => k.p.id));
  // the survivors in a stable order (seq, id) so the clustering is reproducible
  const items = scored.filter((s) => keptSet.has(s.p.id));
  const index = new Map(items.map((s, i) => [s.p.id, i]));

  // 2) variants: merged candidates that point at a surviving primary
  const variantsOf = new Map<string, string[]>();
  for (const m of await loadCandidates(mapRunId, ["merged"])) {
    if (m.merged_into && keptSet.has(m.merged_into)) (variantsOf.get(m.merged_into) ?? variantsOf.set(m.merged_into, []).get(m.merged_into)!).push(m.raw);
  }
  for (const v of variantsOf.values()) v.sort((a, b) => a.localeCompare(b));

  // 3) neighbour graph -> silos
  const idEdges = await loadEdges(mapRunId);
  const edges = toEdges(idEdges, index);
  const groups = clusterSilos(items.length, edges);
  const rawOf = (i: number) => items[i]!.p.raw;
  const pillars = groups.map((g) => pickPillar(g, edges, rawOf));
  // silo order: by total base priority, best first (the user reads the strongest silos first)
  const order = groups.map((_, gi) => gi).sort((x, y) => groups[y]!.reduce((s, i) => s + items[i]!.base, 0) - groups[x]!.reduce((s, i) => s + items[i]!.base, 0) || x - y);

  // 4) silo names (a few small cheap calls in parallel)
  const named = chunk(order, LIMITS.siloNameChunk);
  const names = new Map<number, { name: string; en: string; bn: string }>();
  let nameCost = 0;
  await Promise.all(
    named.map(async (part) => {
      const p = siloNamePrompt(run.topic, locale, part.map((gi) => ({ pillar: rawOf(pillars[gi]!), sample: groups[gi]!.filter((i) => i !== pillars[gi]).slice(0, 5).map(rawOf) })));
      try {
        const r = await callLlm({ task: "silo_naming", workspaceId: ctx.workspaceId, jobId: ctx.jobId, system: p.system, prompt: p.prompt, schema: siloNameResponseSchema, maxOutputTokens: 2000, temperature: 0.3 });
        nameCost += r.costUsd;
        for (const a of r.data) {
          const gi = part[a.i];
          if (gi !== undefined) names.set(gi, { name: a.name, en: a.gloss_en, bn: a.gloss_bn });
        }
      } catch (e) {
        // a naming failure must not sink the plan: those silos get their pillar keyword as name, the editor renames them
        if (!(e instanceof LlmError)) throw e;
      }
    }),
  );

  // 5) rebuild the plan from scratch (idempotent), silos first
  await rpc("map_plan_reset", { p_run: mapRunId });
  const siloRows = order.map((gi, position) => {
    const n = names.get(gi);
    return {
      workspace_id: ctx.workspaceId, project_id: projectId, map_run_id: mapRunId, position, size: groups[gi]!.length,
      name: siloNameOrFallback(n?.name, rawOf(pillars[gi]!)).slice(0, 120), gloss: n ? { en: n.en, bn: n.bn } : {},
    };
  });
  const siloIns = await db().from("silos").insert(siloRows).select("id, position");
  const siloIds = new Map(z.array(z.object({ id: uuid, position: z.number() })).parse(siloIns.data ?? []).map((s) => [s.position, s.id]));
  if (siloIns.error || siloIds.size !== siloRows.length) throw new JobError("silo insert failed", "db_error", { retryable: true });

  // 6) plan items: final score (silo role known), list numbers per silo, stable global position
  const range = listRangeFor(run.params);
  const planRows: Record<string, unknown>[] = [];
  const candUpdates: Record<string, unknown>[] = [];
  let position = 0;
  for (const [pos, gi] of order.entries()) {
    const members = groups[gi]!
      .map((i) => {
        const s = scoreOf(items[i]!.p, i === pillars[gi] ? "pillar" : "supporting");
        return { i, ...s };
      })
      .sort((x, y) => y.detail.priority - x.detail.priority || x.i - y.i);
    const typeA = members.filter((m) => m.type === "A");
    const counts = assignListCounts(typeA.length, range, `${mapRunId}:${pos}`);
    const countOf = new Map(typeA.map((m, k) => [m.i, counts[k]!]));
    for (const m of members) {
      const it = items[m.i]!;
      const listCount = m.type === "A" ? countOf.get(m.i) ?? null : null;
      planRows.push({
        workspace_id: ctx.workspaceId, project_id: projectId, map_run_id: mapRunId, silo_id: siloIds.get(pos), primary_kw_id: it.p.id, keyword: it.p.raw,
        variants: variantsOf.get(it.p.id) ?? [], article_type: m.type, list_count: listCount, target_words: targetWords(m.type, listCount),
        intent: it.p.intent ?? m.intent, funnel: it.p.funnel, priority: m.detail.priority,
        score_detail: { parts: m.detail.parts, notes: m.detail.notes, silo_role: m.i === pillars[gi] ? "pillar" : "supporting" },
        flags: it.p.flags, position: position++,
      });
      candUpdates.push({ id: it.p.id, priority: m.detail.priority });
    }
  }
  const pillarItem = new Map<string, string>(); // primary kw id -> plan item id (only pillars are needed)
  const pillarKw = new Set(pillars.map((pi) => items[pi]!.p.id));
  for (const part of chunk(planRows, 200)) {
    const ins = await db().from("plan_items").insert(part).select("id, primary_kw_id");
    if (ins.error) throw new JobError("plan item insert failed", "db_error", { retryable: true });
    for (const row of z.array(z.object({ id: uuid, primary_kw_id: uuid })).parse(ins.data ?? [])) if (pillarKw.has(row.primary_kw_id)) pillarItem.set(row.primary_kw_id, row.id);
  }
  for (const [pos, gi] of order.entries()) {
    const itemId = pillarItem.get(items[pillars[gi]!]!.p.id);
    if (!itemId) throw new JobError("pillar item missing", "db_error", { retryable: true });
    const upd = await db().from("silos").update({ pillar_item_id: itemId }).eq("id", siloIds.get(pos)!);
    if (upd.error) throw new JobError("pillar link failed", "db_error", { retryable: true });
  }
  for (const part of chunk(candUpdates, 500)) await rpc("kw_apply_classification", { p_run: mapRunId, p_items: part });

  const typeB = planRows.filter((r) => r.article_type === "B").length;
  const stats = {
    plan_items: planRows.length, silos: siloRows.length, dropped_over_target: dropped.length, neighbour_edges: edges.length,
    no_vector_edges: items.length > 1 && edges.length === 0, type_a: planRows.length - typeB, type_b: typeB,
    silos_unnamed: siloRows.length - names.size, silo_names_cost_usd: Math.round(nameCost * 1e6) / 1e6,
  };
  await rpc("map_run_merge_stats", { p_run: mapRunId, p_stats: stats });

  // 7) titles: fan-out over the plan items in position order
  const slices = ranges(planRows.length, LIMITS.titleChunk);
  for (const { from, to } of slices) {
    await enqueue(ctx, "map.s7_titles", { mapRunId, from, to }, `map:${mapRunId}:s7:${from}`, { provider: "anthropic", stage: "s7_titles" });
  }
  await setStage(mapRunId, "s7_titles");
  await enqueueAdvance(ctx, mapRunId, "titles", 0, 0, 10);
  return { ...stats, title_jobs: slices.length };
};

// ---------------------------------------------------------------------------------------------------------------------
// S7: titles + glosses
// ---------------------------------------------------------------------------------------------------------------------
const planRow = z.object({ id: uuid, keyword: z.string(), article_type: z.enum(["A", "B"]), list_count: z.number().int().nullable(), flags: z.array(z.string()) });

const s7titles: JobHandler = async (ctx) => {
  const { mapRunId, from, to } = parsePayload(rangePayload, ctx.payload);
  const run = await liveRun(ctx, mapRunId);
  if (!run) return { skipped: "run_not_live" };
  const locale = run.locale as Locale;

  const res = await db().from("plan_items").select("id, keyword, article_type, list_count, flags").eq("map_run_id", mapRunId).order("position").range(from, to - 1);
  if (res.error) throw new JobError("plan items read failed", "db_error", { retryable: true });
  const rows = z.array(planRow).parse(res.data ?? []);
  if (rows.length === 0) return { titled: 0 };

  const p = titlePrompt(run.topic, locale, rows.map((r) => ({ keyword: r.keyword, type: r.article_type, listCount: r.list_count })));
  const r = await callLlm({ task: "title_generation", workspaceId: ctx.workspaceId, jobId: ctx.jobId, system: p.system, prompt: p.prompt, schema: titleResponseSchema, maxOutputTokens: 4000, temperature: 0.7 });
  const byIndex = new Map(r.data.map((x) => [x.i, x]));

  let fallbacks = 0;
  const items = rows.map((row, i) => {
    const a = byIndex.get(i);
    const clean = cleanTitles(a?.titles ?? [], row.article_type, row.list_count, row.keyword, locale);
    if (clean.fallback) fallbacks++;
    return {
      id: row.id,
      title: clean.options[0],
      title_options: clean.options,
      gloss: { keyword: { en: a?.keyword_gloss_en ?? "", bn: a?.keyword_gloss_bn ?? "" }, title: { en: a?.title_gloss_en ?? "", bn: a?.title_gloss_bn ?? "" } },
      ...(clean.fallback ? { flags: ["title_fallback"] } : {}),
    };
  });
  await rpc("plan_items_apply", { p_run: mapRunId, p_items: items });
  return { titled: rows.length, fallbacks, provider: r.provider, model_key: r.modelKey, cost_usd: r.costUsd };
};

// ---------------------------------------------------------------------------------------------------------------------
// S8: slugs + internal link plan
// ---------------------------------------------------------------------------------------------------------------------
const planFull = z.object({ id: uuid, silo_id: uuid.nullable(), primary_kw_id: uuid, keyword: z.string(), variants: z.array(z.string()), priority: z.coerce.number() });

async function loadPlanItems(runId: string) {
  const rows = await readAll<unknown>((from, to) => db().from("plan_items").select("id, silo_id, primary_kw_id, keyword, variants, priority").eq("map_run_id", runId).order("position").range(from, to));
  return rows.map((r) => {
    const p = planFull.safeParse(r);
    if (!p.success) throw new JobError("plan item row invalid", "db_invalid_row", { retryable: false });
    return p.data;
  });
}

const s8links: JobHandler = async (ctx) => {
  const { mapRunId } = parsePayload(basePayload, ctx.payload);
  const run = await liveRun(ctx, mapRunId);
  if (!run) return { skipped: "run_not_live" };
  await setStage(mapRunId, "s8_links");

  const items = await loadPlanItems(mapRunId);
  const slugs = buildSlugs(items.map((i) => i.keyword), langOf(run));

  const siloRes = await db().from("silos").select("id, pillar_item_id, position").eq("map_run_id", mapRunId).order("position");
  const silos = z.array(z.object({ id: uuid, pillar_item_id: uuid.nullable(), position: z.number() })).parse(siloRes.data ?? []);
  const siloIndex = new Map(silos.map((s, i) => [s.id, i]));
  const itemIndexById = new Map(items.map((it, i) => [it.id, i]));
  const pillarIndexOfSilo = new Map<number, number>();
  for (const [si, s] of silos.entries()) {
    const pi = s.pillar_item_id ? itemIndexById.get(s.pillar_item_id) : undefined;
    if (pi !== undefined) pillarIndexOfSilo.set(si, pi);
  }

  const kwIndex = new Map(items.map((it, i) => [it.primary_kw_id, i]));
  const edges = toEdges(await loadEdges(mapRunId), kwIndex);
  const plans = buildLinkPlans(
    items.map((it, i) => ({ id: it.id, keyword: it.keyword, variants: it.variants, siloIndex: it.silo_id ? siloIndex.get(it.silo_id) ?? -1 : -1, priorityRank: i })),
    pillarIndexOfSilo,
    edges,
  );

  const updates = items.map((it, i) => ({ id: it.id, slug: slugs[i], link_plan: plans[i] }));
  for (const part of chunk(updates, 200)) await rpc("plan_items_apply", { p_run: mapRunId, p_items: part });

  await enqueue(ctx, "map.s9_verify", { mapRunId }, `map:${mapRunId}:s9`, { stage: "s9_verify" });
  await setStage(mapRunId, "s9_verify");
  return { slugs: slugs.length, link_plans: plans.length, silos: silos.length };
};

// ---------------------------------------------------------------------------------------------------------------------
// S9: verification report, snapshot, commit
// ---------------------------------------------------------------------------------------------------------------------
const pairRow = z.object({ a: uuid, b: uuid, cosine: z.number().nullable(), verdict: z.string().nullable(), judged_by: z.string().nullable(), reason: z.string().nullable() });
const planVerify = z.object({
  id: uuid, primary_kw_id: uuid, keyword: z.string(), variants: z.array(z.string()), title: z.string().nullable(), title_options: z.array(z.string()), slug: z.string().nullable(),
  article_type: z.enum(["A", "B"]), list_count: z.number().int().nullable(), silo_id: uuid.nullable(), intent: z.string().nullable(), flags: z.array(z.string()),
});
const qaResponseSchema = z.array(z.object({ i: z.number().int().min(0), ok: z.boolean(), issue: z.string().optional().transform((v) => (v ?? "").trim().slice(0, 200)) })).min(1);

/** Providers that produced this run's judgements and titles (from the jobs' results): the independent checks must avoid them. */
async function producerProviders(runId: string): Promise<string[]> {
  const res = await db().from("jobs").select("result").in("type", ["map.s4_judge", "map.s7_titles", "map.s5_classify"]).contains("payload", { mapRunId: runId }).limit(1000);
  if (res.error) return [];
  const seen = new Map<string, number>();
  for (const j of (res.data ?? []) as { result?: { provider?: unknown; providers?: unknown } | null }[]) {
    const list = Array.isArray(j.result?.providers) ? j.result.providers : typeof j.result?.provider === "string" ? [j.result.provider] : [];
    for (const p of list) if (typeof p === "string") seen.set(p, (seen.get(p) ?? 0) + 1);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
}
const asProvider = (p: string | undefined): "anthropic" | "openai" | "gemini" | undefined => (p === "anthropic" || p === "openai" || p === "gemini" ? p : undefined);

const notSame = (v: string) => v !== "same";

/** n items spread evenly over the list (reproducible, covers every silo because the list is in silo order). */
function stride<T>(xs: readonly T[], n: number): T[] {
  if (xs.length <= n) return [...xs];
  const step = xs.length / n;
  return Array.from({ length: n }, (_, i) => xs[Math.floor(i * step)]!);
}

async function runAudit(ctx: JobContext, runId: string, producers: string[], labelOf: Map<string, string>, pairs: z.infer<typeof pairRow>[]): Promise<Audit> {
  const empty = { sampledSame: 0, sampledSeparate: 0, wrongMerges: [], missedDuplicates: [] };
  const decided = pairs.filter((p) => p.verdict !== null && p.judged_by !== "cap" && p.cosine !== null);
  const toPool = (ps: typeof decided) => ps.map((p) => ({ a: p.a, b: p.b, cosine: p.cosine! }));
  const sameSample = samplePairs(toPool(decided.filter((p) => p.verdict === "same")), LIMITS.auditSample);
  const sepSample = samplePairs(toPool(decided.filter((p) => p.verdict !== "same")), LIMITS.auditSample);
  const sample = [...sameSample.map((p) => ({ ...p, was: "same" })), ...sepSample.map((p) => ({ ...p, was: "separate" }))];
  if (sample.length === 0) return { ran: false, reason: "no judged pairs to audit", ...empty };
  const avoid = asProvider(producers[0]);
  try {
    const r = await callLlm({
      task: "map_audit", workspaceId: ctx.workspaceId, jobId: ctx.jobId, system: JUDGE_SYSTEM,
      prompt: buildJudgePrompt(sample.map((s) => ({ a: labelOf.get(s.a) ?? s.a, b: labelOf.get(s.b) ?? s.b }))),
      schema: judgeResponseSchema, maxOutputTokens: 3000, temperature: 0, ...(avoid ? { avoidProvider: avoid } : {}),
    });
    if (producers.includes(r.provider)) return { ran: false, reason: "only a model of the same provider as the producer was available", ...empty };
    const answer = new Map(r.data.map((x) => [x.i, x]));
    const wrongMerges: Audit["wrongMerges"] = [];
    const missedDuplicates: Audit["missedDuplicates"] = [];
    sample.forEach((s, i) => {
      const a = answer.get(i);
      if (!a) return;
      const pair = { a: labelOf.get(s.a) ?? s.a, b: labelOf.get(s.b) ?? s.b, reason: a.reason };
      if (s.was === "same" && notSame(a.verdict)) wrongMerges.push(pair);
      if (s.was === "separate" && !notSame(a.verdict)) missedDuplicates.push(pair);
    });
    return { ran: true, provider: r.provider, sampledSame: sameSample.length, sampledSeparate: sepSample.length, wrongMerges, missedDuplicates };
  } catch (e) {
    if (e instanceof LlmError) return { ran: false, reason: e.code, ...empty };
    throw e;
  }
}

async function runLanguageQa(ctx: JobContext, run: Run, producers: string[], sample: { keyword: string; title: string | null }[]): Promise<LangQa> {
  if (sample.length === 0) return { ran: false, reason: "no items", sampled: 0, flagged: [] };
  const lang = run.locale === "en-US" ? "US English" : run.locale === "es-MX" ? "Mexican Spanish" : run.locale === "es-US" ? "US Spanish" : "Castilian Spanish";
  const avoid = asProvider(producers[0]);
  try {
    const r = await callLlm({
      task: "qa_cross_judge", workspaceId: ctx.workspaceId, jobId: ctx.jobId, maxOutputTokens: 3000, temperature: 0, schema: qaResponseSchema, ...(avoid ? { avoidProvider: avoid } : {}),
      system: `You are a native ${lang} language reviewer. For each keyword and title decide if it is natural ${lang} for its audience. Flag (ok=false, short issue) English leakage (brand names are fine), vocabulary of another region, garbled or unnatural phrasing, grammar errors. Return only JSON: [{"i":0,"ok":true,"issue":""}], one object per line, same order.`,
      prompt: sample.map((s, i) => `${i}. keyword: "${s.keyword}" | title: "${s.title ?? ""}"`).join("\n"),
    });
    if (producers.includes(r.provider)) return { ran: false, reason: "only a model of the same provider as the producer was available", sampled: 0, flagged: [] };
    const answer = new Map(r.data.map((x) => [x.i, x]));
    const flagged = sample.flatMap((s, i) => {
      const a = answer.get(i);
      return a && !a.ok ? [{ keyword: s.keyword, issue: a.issue || "flagged by the reviewer" }] : [];
    });
    return { ran: true, provider: r.provider, sampled: sample.length, flagged };
  } catch (e) {
    if (e instanceof LlmError) return { ran: false, reason: e.code, sampled: 0, flagged: [] };
    throw e;
  }
}

const s9verify: JobHandler = async (ctx) => {
  const { mapRunId } = parsePayload(basePayload, ctx.payload);
  const run = await liveRun(ctx, mapRunId);
  if (!run) return { skipped: "run_not_live" };
  await setStage(mapRunId, "s9_verify");

  const planRes = await readAll<unknown>((from, to) =>
    db().from("plan_items").select("id, primary_kw_id, keyword, variants, title, title_options, slug, article_type, list_count, silo_id, intent, flags").eq("map_run_id", mapRunId).order("position").range(from, to),
  );
  const plan = planRes.map((r) => {
    const p = planVerify.safeParse(r);
    if (!p.success) throw new JobError("plan item row invalid", "db_invalid_row", { retryable: false });
    return p.data;
  });
  const siloRes = await db().from("silos").select("id, name, size").eq("map_run_id", mapRunId).order("position");
  const silos = z.array(z.object({ id: uuid, name: z.string(), size: z.number() })).parse(siloRes.data ?? []);
  const facetRes = await db().from("facets").select("id, name").eq("map_run_id", mapRunId).is("parent_id", null);
  const facets = z.array(z.object({ id: uuid, name: z.string() })).parse(facetRes.data ?? []);

  const primaries = await loadPrimaries(mapRunId);
  const primaryOf = new Map(primaries.map((p) => [p.id, p]));
  const vitems: VItem[] = plan.map((it) => ({
    id: it.id, keyword: it.keyword, variants: it.variants, normKey: primaryOf.get(it.primary_kw_id)?.norm_key ?? null, intent: it.intent, flags: it.flags, slug: it.slug,
    title: it.title, titleOptions: it.title_options, articleType: it.article_type, listCount: it.list_count, siloId: it.silo_id, facetId: primaryOf.get(it.primary_kw_id)?.facet_id ?? null,
  }));
  const itemOfKw = new Map(plan.map((it) => [it.primary_kw_id, it.id]));

  const pairRows = (
    await readAll<unknown>((from, to) => db().from("kw_pairs").select("a, b, cosine, verdict, judged_by, reason").eq("map_run_id", mapRunId).order("a").order("b").range(from, to))
  ).map((r) => pairRow.parse(r));
  const verdictOf = new Map(pairRows.map((p) => [`${p.a}|${p.b}`, p.verdict]));
  const edges = await loadEdges(mapRunId);
  const seenPair = new Set<string>();
  const vpairs: VPair[] = [];
  for (const e of edges) {
    const a = itemOfKw.get(e.a);
    const b = itemOfKw.get(e.b);
    if (!a || !b) continue;
    const [lo, hi] = e.a < e.b ? [e.a, e.b] : [e.b, e.a];
    const key = `${lo}|${hi}`;
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    vpairs.push({ a, b, cosine: e.cosine, verdict: verdictOf.get(key) ?? null });
  }

  const producers = await producerProviders(mapRunId);
  const labelOf = new Map((await loadCandidates(mapRunId)).map((c) => [c.id, c.raw]));
  const qaSample = stride(vitems, LIMITS.qaSample).map((v) => ({ keyword: v.keyword, title: v.title }));
  const [audit, qa] = await Promise.all([runAudit(ctx, mapRunId, producers, labelOf, pairRows), runLanguageQa(ctx, run, producers, qaSample)]);

  const thresholds = thresholdsFor(run.params);
  const range = listRangeFor(run.params);
  const checks = [
    checkDuplicates(vitems, vpairs, thresholds.high),
    checkCannibalization(vitems, vpairs),
    checkCoverage(vitems, facets),
    checkIntent(vitems),
    checkLanguage(vitems, run.locale as Locale, qa),
    checkExistingContent(),
    checkPolicy(vitems),
    checkAudit(audit),
    checkSizeBalance(vitems, silos, { min: run.target_min, max: run.target_max }),
    checkRules(vitems, range),
  ];
  const report = buildReport(checks);
  await rpc("map_run_set_report", { p_run: mapRunId, p_report: report });

  const cost = z.coerce.number().parse(await rpc("map_run_cost_usd", { p_run: mapRunId }));
  const stats = { verdict: report.verdict, check_counts: report.counts, cost_usd: cost, independent_checks_by: { audit: audit.provider ?? null, language_qa: qa.provider ?? null } };
  await rpc("map_run_merge_stats", { p_run: mapRunId, p_stats: stats });
  await rpc("map_snapshot_create", { p_run: mapRunId, p_summary: { verdict: report.verdict, counts: report.counts, plan_items: plan.length, silos: silos.length } });
  // The run succeeds even when the report is red: the work was delivered and paid for; a red report keeps the items in `draft`.
  await rpc("map_run_finish", { p_run: mapRunId, p_status: "succeeded" });
  return stats;
};

export const planHandlers: Record<string, JobHandler> = {
  "map.s5_classify": s5classify,
  "map.s6_silos": s6silos,
  "map.s7_titles": s7titles,
  "map.s8_links": s8links,
  "map.s9_verify": s9verify,
};
