import { z } from "zod";

/**
 * Pure logic of batches (PLAN §4.2): which approved items are written together.
 * The database (0016) enforces the rules; this module only SUGGESTS the grouping and parses the forms.
 */

export const DEFAULT_BATCH_SIZE = 15; // PLAN: 10-20 per batch by default
export const MIN_BATCH_SIZE = 5;
export const MAX_BATCH_SIZE = 50;
export const MAX_ITEMS_PER_BATCH = 100; // same limit as batches_create

export type BatchableItem = { id: string; siloId: string | null; priority: number; position: number; isPillar: boolean };
export type SiloRef = { id: string; name: string; position: number };
export type SuggestedBatch = {
  siloId: string | null;
  name: string;
  itemIds: string[];
  /** the main article (pillar) of the silo is the first item of this batch */
  hasPillar: boolean;
  /** the silo's pillar is NOT part of these approved items yet: this batch will be written without it */
  pillarPending: boolean;
};

export function clampBatchSize(n: unknown): number {
  if (n === null || n === undefined || n === "") return DEFAULT_BATCH_SIZE;
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return DEFAULT_BATCH_SIZE;
  return Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, Math.round(v)));
}

/** n items into ceil(n/size) batches of (almost) equal size: 28 with size 15 -> 14 + 14, never 15 + 13 + a stub. */
export function balancedSizes(n: number, size: number): number[] {
  if (n <= 0) return [];
  const k = Math.ceil(n / Math.max(1, size));
  const base = Math.floor(n / k);
  const extra = n % k;
  return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Suggestion for the APPROVED items that are not in a batch yet (the caller passes only those), silo by silo:
 * the pillar first (so the group's main article exists before the articles that link to it), then higher priority first,
 * ties by position then id (stable). `waitingPillarSilos` = silos whose pillar is still only proposed (not approved): their
 * first batch is flagged `pillarPending`, because it will be written without the main article.
 */
export function suggestBatches(items: BatchableItem[], silos: SiloRef[], size: number, waitingPillarSilos: ReadonlySet<string> = new Set()): SuggestedBatch[] {
  const s = clampBatchSize(size);
  const out: SuggestedBatch[] = [];
  const ordered = [...silos].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const groups: { id: string | null; name: string }[] = [...ordered.map((x) => ({ id: x.id, name: x.name })), { id: null, name: "No group" }];
  for (const g of groups) {
    const mine = items.filter((i) => (i.siloId ?? null) === g.id);
    if (mine.length === 0) continue;
    mine.sort((a, b) => Number(b.isPillar) - Number(a.isPillar) || b.priority - a.priority || a.position - b.position || a.id.localeCompare(b.id));
    const sizes = balancedSizes(mine.length, s);
    let from = 0;
    sizes.forEach((n, idx) => {
      const part = mine.slice(from, from + n);
      from += n;
      out.push({
        siloId: g.id,
        name: sizes.length === 1 ? g.name : `${g.name} · ${idx + 1}/${sizes.length}`,
        itemIds: part.map((i) => i.id),
        hasPillar: idx === 0 && part[0]?.isPillar === true,
        pillarPending: idx === 0 && g.id !== null && waitingPillarSilos.has(g.id) && !part.some((i) => i.isPillar),
      });
    });
  }
  return out;
}

/** The first suggested batch of every silo ("next batch" per silo card). */
export function nextBatchBySilo(suggestions: SuggestedBatch[]): Map<string | null, SuggestedBatch> {
  const m = new Map<string | null, SuggestedBatch>();
  for (const b of suggestions) if (!m.has(b.siloId)) m.set(b.siloId, b);
  return m;
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------
const uuid = z.string().uuid();

/** "all": every suggested batch of every silo; "next": only the first suggested batch of one silo. */
export const autoFormSchema = z.discriminatedUnion("intent", [
  z.object({ run: uuid, size: z.number().int(), intent: z.literal("all") }),
  z.object({ run: uuid, size: z.number().int(), intent: z.literal("next"), silo: uuid }),
]);
export type AutoForm = z.infer<typeof autoFormSchema>;

export function parseAutoForm(fd: FormData): AutoForm | null {
  const p = autoFormSchema.safeParse({ run: fd.get("run"), size: clampBatchSize(fd.get("size")), intent: fd.get("intent"), silo: fd.get("silo") ?? undefined });
  return p.success ? p.data : null;
}

export const manualFormSchema = z.object({
  run: uuid,
  name: z.string().trim().min(1).max(120),
  ids: z.array(uuid).min(1).max(MAX_ITEMS_PER_BATCH),
});
export function parseManualForm(fd: FormData): z.infer<typeof manualFormSchema> | null {
  const p = manualFormSchema.safeParse({ run: fd.get("run"), name: fd.get("name"), ids: [...new Set(fd.getAll("id").map(String))] });
  return p.success ? p.data : null;
}

export const batchActionSchema = z.discriminatedUnion("intent", [
  z.object({ run: uuid, batch: uuid, intent: z.literal("cancel") }),
  z.object({ run: uuid, batch: uuid, intent: z.literal("remove"), ids: z.array(uuid).min(1).max(1000) }),
]);
export function parseBatchAction(fd: FormData): z.infer<typeof batchActionSchema> | null {
  const p = batchActionSchema.safeParse({ run: fd.get("run"), batch: fd.get("batch"), intent: fd.get("intent"), ids: [...new Set(fd.getAll("id").map(String))] });
  return p.success ? p.data : null;
}
