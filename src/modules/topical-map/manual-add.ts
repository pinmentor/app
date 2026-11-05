import { z } from "zod";
import { cosine } from "./embed";
import { decidePair, type Thresholds } from "./compare";
import { normalize } from "./normalize";
import type { Locale } from "./lexicon";

/**
 * Pure helpers of "add a keyword" on the map review page (B24b): form parsing, the duplicate check and the demand label.
 * No model judge and no credits: deterministic rules plus one embedding of the new text. The SQL functions
 * plan_item_add_manual / plan_item_add_variant enforce the hard rules; this only decides what the owner is asked.
 */

const uuid = z.string().uuid();
export const MAX_KEYWORD_CHARS = 200;
export const MAX_KEYWORD_WORDS = 12;

export const addFormSchema = z.object({
  run: uuid,
  text: z.string().trim().min(1).max(MAX_KEYWORD_CHARS).refine((t) => t.split(/\s+/).length <= MAX_KEYWORD_WORDS),
  silo: uuid,
  title: z.string().trim().max(200).optional(),
  gloss: z.string().optional(),
});
export type AddForm = z.infer<typeof addFormSchema> & { force: boolean; variantOf: string | null; intent: "check" | "force" | "variant" };

export function parseAddForm(fd: FormData): AddForm | null {
  // the "add as a variant of X" buttons send variant_of=X and no intent
  const intentRaw = fd.get("variant_of") ? "variant" : String(fd.get("intent") ?? "check");
  const intent = intentRaw === "force" || intentRaw === "variant" ? intentRaw : "check";
  const base = addFormSchema.safeParse({
    run: String(fd.get("run") ?? ""),
    text: String(fd.get("text") ?? ""),
    silo: String(fd.get("silo") ?? ""),
    title: String(fd.get("title") ?? "") || undefined,
    gloss: String(fd.get("gloss") ?? "") || undefined,
  });
  if (!base.success) return null;
  let variantOf: string | null = null;
  if (intent === "variant") {
    const v = uuid.safeParse(String(fd.get("variant_of") ?? ""));
    if (!v.success) return null;
    variantOf = v.data;
  }
  return { ...base.data, force: intent === "force", variantOf, intent };
}

/** One thing the new text can be compared with: an item's own keyword, or one of its variants. */
export type Existing = { itemId: string; keyword: string; text: string; isVariant: boolean; siloName: string; vector: number[] | null };
export type Match = { itemId: string; keyword: string; text: string; isVariant: boolean; siloName: string; kind: "same" | "similar"; reason: string };

/**
 * Same intent -> "same" (exact key, same content words, or cosine >= high). One keyword adding modifiers to the other,
 * or a borderline cosine -> "similar". A hard modifier conflict (ninas vs ninos, con vs sin) is never a match.
 * Variants carry no embedding, so they are compared by the rules only. Best matches first, at most 5.
 */
export function findMatches(text: string, locale: Locale, thresholds: Thresholds, newVector: number[] | null, existing: Existing[]): Match[] {
  const nn = normalize(text, locale);
  const out: Match[] = [];
  for (const e of existing) {
    const cos = newVector && e.vector ? cosine(newVector, e.vector) : 0;
    const d = decidePair(nn, normalize(e.text, locale), cos, thresholds);
    if (d.verdict === "different") continue;
    const kind = d.verdict === "same" ? "same" : "similar";
    out.push({ itemId: e.itemId, keyword: e.keyword, text: e.text, isVariant: e.isVariant, siloName: e.siloName, kind, reason: d.reason });
  }
  const rank = (m: Match) => (m.kind === "same" ? 0 : 1);
  out.sort((a, b) => rank(a) - rank(b));
  return out.slice(0, 5);
}

/** pgvector comes back from PostgREST as the text "[0.1,0.2,...]" (or already an array). Anything else -> null. */
export function parseVector(v: unknown): number[] | null {
  if (Array.isArray(v)) return v.every((x) => typeof x === "number") ? (v as number[]) : null;
  if (typeof v !== "string" || !v.startsWith("[") || !v.endsWith("]")) return null;
  const parts = v.slice(1, -1).split(",");
  const nums = parts.map(Number);
  return nums.length > 0 && nums.every((n) => Number.isFinite(n)) ? nums : null;
}

/**
 * Demand label (PLAN §3.7, docx §4): a model's tier is an ESTIMATE, never a search volume. Only a provider number is shown
 * as a number. Nothing known -> empty string.
 */
export function demandLabel(c: { demand_tier: number | null; demand_source: string | null; volume: number | null }): string {
  if (c.demand_source === "provider" && c.volume != null) return `provider | ${c.volume.toLocaleString("en-US")}/mo`;
  if (c.demand_tier != null && c.demand_tier >= 1 && c.demand_tier <= 5) return `estimate | ${["very low", "low", "medium", "high", "very high"][c.demand_tier - 1]}`;
  return "";
}
