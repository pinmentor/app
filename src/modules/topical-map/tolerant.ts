import { z } from "zod";

/**
 * LLM answers that are lists: one odd item must not cost the whole (paid) answer. The wrapper accepts a bare array or
 * an object holding exactly one array (models like to answer {"results":[...]}), keeps every item that passes
 * `item` and drops the rest. Callers treat a missing item as "no answer for this one" (kept separate / flagged),
 * never as a guess. An answer with no usable item at all is still rejected, so the router can try the next model.
 */
function unwrap(v: unknown): unknown {
  if (Array.isArray(v) || typeof v !== "object" || v === null) return v;
  const arrays = Object.values(v).filter(Array.isArray);
  return arrays.length === 1 ? arrays[0] : v;
}

export function tolerantList<T extends z.ZodType>(item: T) {
  return z
    .preprocess(unwrap, z.array(z.unknown()))
    .transform((xs) => xs.flatMap((x) => {
      const r = item.safeParse(x);
      return r.success ? [r.data as z.output<T>] : [];
    }))
    .refine((a) => a.length > 0, { message: "no usable items" });
}

/** "Parent-Child", " same " -> parent_child, same. */
export const cleanLabel = (v: unknown): unknown => (typeof v === "string" ? v.trim().toLowerCase().replace(/[\s-]+/g, "_") : v);
export const shortText = (max: number) => (v: unknown): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
