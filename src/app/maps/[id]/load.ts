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
});

export type MapRun = z.infer<typeof runSchema>;
export type MapSilo = z.infer<typeof siloSchema>;
export type MapItem = z.infer<typeof itemSchema>;
export type MapBatch = z.infer<typeof batchSchema>;
export type LoadedMap = { run: MapRun; silos: MapSilo[]; items: MapItem[]; batches: MapBatch[] };

/** Reads one map through the user's session (RLS): another workspace's map is simply not found (null). Null also on a load error. */
export async function loadMap(supabase: Db, runId: string): Promise<LoadedMap | null> {
  const runRes = await supabase.from("map_runs").select("id, topic, locale, status, target_max").eq("id", runId).maybeSingle();
  const run = runSchema.safeParse(runRes.data);
  if (!run.success) return null;
  const [silosRes, itemsRes, batchesRes] = await Promise.all([
    supabase.from("silos").select("id, name, size, position, pillar_item_id").eq("map_run_id", runId).order("position"),
    supabase.from("plan_items").select("id, silo_id, keyword, title, status, batch_id, priority, position, flags").eq("map_run_id", runId).order("position").limit(1000),
    supabase.from("batches").select("id, silo_id, name, origin, status, position, credit_estimate, created_at").eq("map_run_id", runId).order("position"),
  ]);
  const silos = z.array(siloSchema).safeParse(silosRes.data ?? []);
  const items = z.array(itemSchema).safeParse(itemsRes.data ?? []);
  const batches = z.array(batchSchema).safeParse(batchesRes.data ?? []);
  if (silosRes.error || itemsRes.error || batchesRes.error || !silos.success || !items.success || !batches.success) return null;
  return { run: run.data, silos: silos.data, items: items.data, batches: batches.data };
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
