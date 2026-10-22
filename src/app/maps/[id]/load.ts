import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { suggestBatches, type SuggestedBatch } from "@/modules/topical-map/batching";

type Db = Awaited<ReturnType<typeof createClient>>;

const runSchema = z.object({ id: z.string().uuid(), topic: z.string(), locale: z.string(), status: z.string(), target_max: z.number() });
const siloSchema = z.object({ id: z.string().uuid(), name: z.string(), size: z.number(), position: z.number(), pillar_item_id: z.string().uuid().nullable() });
const itemSchema = z.object({
  id: z.string().uuid(), silo_id: z.string().uuid().nullable(), keyword: z.string(), title: z.string().nullable(), status: z.string(),
  batch_id: z.string().uuid().nullable(), priority: z.number(), position: z.number(), flags: z.array(z.string()),
});
const batchSchema = z.object({
  id: z.string().uuid(), silo_id: z.string().uuid().nullable(), name: z.string(), origin: z.string(), status: z.string(), position: z.number(),
  credit_estimate: z.number().nullable(), created_at: z.string(),
  credit_rate: z.number().nullable(), credit_amount: z.number(), started_at: z.string().nullable(), finished_at: z.string().nullable(), stats: z.record(z.string(), z.unknown()),
});
const articleSchema = z.object({
  id: z.string().uuid(), batch_id: z.string().uuid(), plan_item_id: z.string().uuid(), status: z.string(), word_count: z.number().nullable(), last_error: z.string().nullable(),
  qa: z.object({ verdict: z.string().optional() }).passthrough(),
});

export type MapRun = z.infer<typeof runSchema>;
export type MapSilo = z.infer<typeof siloSchema>;
export type MapItem = z.infer<typeof itemSchema>;
export type MapBatch = z.infer<typeof batchSchema>;
export type MapArticle = z.infer<typeof articleSchema>;
export type LoadedMap = { run: MapRun; silos: MapSilo[]; items: MapItem[]; batches: MapBatch[]; articles: MapArticle[] };

/** Reads one map through the user's session (RLS): another workspace's map is simply not found (null). Null also on a load error. */
export async function loadMap(supabase: Db, runId: string): Promise<LoadedMap | null> {
  const runRes = await supabase.from("map_runs").select("id, topic, locale, status, target_max").eq("id", runId).maybeSingle();
  const run = runSchema.safeParse(runRes.data);
  if (!run.success) return null;
  const [silosRes, itemsRes, batchesRes, articlesRes] = await Promise.all([
    supabase.from("silos").select("id, name, size, position, pillar_item_id").eq("map_run_id", runId).order("position"),
    supabase.from("plan_items").select("id, silo_id, keyword, title, status, batch_id, priority, position, flags").eq("map_run_id", runId).order("position").limit(1000),
    supabase.from("batches").select("id, silo_id, name, origin, status, position, credit_estimate, created_at, credit_rate, credit_amount, started_at, finished_at, stats").eq("map_run_id", runId).order("position"),
    supabase.from("articles").select("id, batch_id, plan_item_id, status, word_count, last_error, qa").eq("map_run_id", runId).order("created_at").limit(1000),
  ]);
  const silos = z.array(siloSchema).safeParse(silosRes.data ?? []);
  const items = z.array(itemSchema).safeParse(itemsRes.data ?? []);
  const batches = z.array(batchSchema).safeParse(batchesRes.data ?? []);
  const articles = z.array(articleSchema).safeParse(articlesRes.data ?? []);
  if (articlesRes.error || !articles.success) return null;
  if (silosRes.error || itemsRes.error || batchesRes.error || !silos.success || !items.success || !batches.success) return null;
  return { run: run.data, silos: silos.data, items: items.data, batches: batches.data, articles: articles.data };
}

/** Suggested batches for the approved items that are not in a batch yet. */
export function suggestFor(map: LoadedMap, size: number): SuggestedBatch[] {
  const pillarOf = new Map(map.silos.map((s) => [s.id, s.pillar_item_id]));
  const pillarIds = new Set(map.silos.flatMap((s) => (s.pillar_item_id ? [s.pillar_item_id] : [])));
  const waiting = new Set(
    map.silos.filter((s) => s.pillar_item_id && map.items.find((i) => i.id === s.pillar_item_id)?.status === "proposed").map((s) => s.id),
  );
  const free = map.items
    .filter((i) => i.status === "approved" && !i.batch_id)
    .map((i) => ({ id: i.id, siloId: i.silo_id, priority: i.priority, position: i.position, isPillar: pillarIds.has(i.id) && pillarOf.get(i.silo_id ?? "") === i.id }));
  return suggestBatches(free, map.silos.map((s) => ({ id: s.id, name: s.name, position: s.position })), size, waiting);
}
