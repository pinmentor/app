import { z } from "zod";

/**
 * LLM answers that are lists: one odd item must not cost the whole (paid) answer. The wrapper accepts a bare array or
 * an object holding exactly one array (models like to answer {"results":[...]}), keeps every item that passes
 * `item` and drops the rest. Callers treat a missing item as "no answer for this one" (kept separate / flagged),
 * never as a guess. An answer with no usable item at all is still rejected, so the router can try the next model.
 */
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * JSON-mode models must answer with an object, so a list comes back in many shapes: [..], {"results":[..]},
 * {"data":{"results":[..]}}, {"0":{..},"1":{..}} (index as key) or one bare item. All become a plain array.
 */
function unwrap(v: unknown, depth = 0): unknown {
  if (Array.isArray(v) || !isObj(v)) return v;
  const values = Object.values(v);
  const arrays = values.filter(Array.isArray);
  if (arrays.length === 1) return arrays[0];
  if (depth < 2) {
    const nested = values.filter(isObj);
    if (nested.length === 1 && values.length === 1) return unwrap(nested[0], depth + 1);
  }
  if ("i" in v || "index" in v || "id" in v) return [v];
  const keys = Object.keys(v);
  if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k)) && values.every(isObj)) return keys.map((k) => ({ i: Number(k), ...(v[k] as Record<string, unknown>) }));
  return v;
}

/** Models name the item number differently: i, index, id, idx, n. */
function normalizeItem(x: unknown): unknown {
  if (!isObj(x) || x.i !== undefined) return x;
  const alt = x.index ?? x.idx ?? x.id ?? x.n;
  return alt === undefined ? x : { ...x, i: alt };
}

export function tolerantList<T extends z.ZodType>(item: T) {
  return z
    .preprocess((v) => unwrap(v), z.array(z.unknown()))
    .transform((xs) => xs.flatMap((x) => {
      const r = item.safeParse(normalizeItem(x));
      return r.success ? [r.data as z.output<T>] : [];
    }))
    .refine((a) => a.length > 0, { message: "no usable items" });
}

/**
 * Zod 4 rejects an object whose key is missing when that key is `z.unknown().transform(...)` (zod 3 let it through), so
 * a model that leaves out a gloss would lose the whole item. Missing keys are filled with null first; the transform
 * then turns null into its default. Works the same in every zod version.
 */
export function withKeys<T extends z.ZodType>(keys: readonly string[], schema: T) {
  return z.preprocess((v) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return v;
    const filled: Record<string, unknown> = {};
    for (const k of keys) filled[k] = null;
    return { ...filled, ...(v as Record<string, unknown>) };
  }, schema);
}

/** "Parent-Child", " same " -> parent_child, same. */
export const cleanLabel = (v: unknown): unknown => (typeof v === "string" ? v.trim().toLowerCase().replace(/[\s-]+/g, "_") : v);
export const shortText = (max: number) => (v: unknown): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
