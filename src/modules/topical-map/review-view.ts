import { z } from "zod";

/** Pure helpers of the map review pages (admin and user): translation display, report shape, review form. */

export const checkSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["pass", "flag", "fail", "skipped"]),
  summary: z.string(),
  details: z.array(z.unknown()).optional(),
});
export const reportSchema = z.object({ verdict: z.enum(["pass", "flag", "fail"]), checks: z.array(checkSchema), note: z.string().optional() });
export type Report = z.infer<typeof reportSchema>;

/** Translation shown next to the map's own text: off (default), Bengali, English or both. */
export const GLOSS_MODES = ["off", "bn", "en", "both"] as const;
export type GlossMode = (typeof GLOSS_MODES)[number];
export const GLOSS_LABEL: Record<GlossMode, string> = { off: "Off", bn: "বাংলা", en: "English", both: "Both" };

export function parseGlossMode(v: unknown): GlossMode {
  const p = z.enum(GLOSS_MODES).safeParse(v);
  return p.success ? p.data : "off";
}

/** gloss = {keyword:{en,bn}, title:{en,bn}} written by S7; anything else renders as nothing. */
export function glossLine(g: Record<string, unknown>, part: "keyword" | "title", mode: GlossMode): string {
  if (mode === "off") return "";
  const p = z.object({ en: z.string().optional(), bn: z.string().optional() }).safeParse(g[part]);
  if (!p.success) return "";
  const picked = mode === "bn" ? [p.data.bn] : mode === "en" ? [p.data.en] : [p.data.en, p.data.bn];
  return picked.filter(Boolean).join(" · ");
}

/** All item statuses of PLAN §4.1 (0015). People set only REVIEW_STATUSES from the review page; the rest follow the workflow. */
export const ITEM_STATUSES = [
  "proposed", "approved", "in_batch", "writing", "draft_ready", "in_review", "scheduled", "published", "pins_pending", "done", "rejected", "already_exists",
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const REVIEW_STATUSES = ["proposed", "approved", "rejected"] as const;

export function statusCounts(statuses: string[]): Record<ItemStatus, number> {
  const out = Object.fromEntries(ITEM_STATUSES.map((s) => [s, 0])) as Record<ItemStatus, number>;
  for (const s of statuses) if ((ITEM_STATUSES as readonly string[]).includes(s)) out[s as ItemStatus] += 1;
  return out;
}

/** The review form: which items, what to do. `approve_clean` needs no ids. */
export const REVIEW_INTENTS = ["approve", "reject", "proposed", "approve_clean"] as const;
export const reviewFormSchema = z.object({
  run: z.string().uuid(),
  intent: z.enum(REVIEW_INTENTS),
  ids: z.array(z.string().uuid()).max(1000),
  gloss: z.enum(GLOSS_MODES).catch("off"),
});

export function parseReviewForm(fd: FormData): z.infer<typeof reviewFormSchema> | null {
  const p = reviewFormSchema.safeParse({ run: fd.get("run"), intent: fd.get("intent"), ids: fd.getAll("id").map(String), gloss: fd.get("gloss") });
  if (!p.success) return null;
  if (p.data.intent !== "approve_clean" && p.data.ids.length === 0) return null;
  return p.data;
}

/** Status the SQL function gets for an intent (approve_clean has its own function). */
export function statusForIntent(intent: "approve" | "reject" | "proposed"): (typeof REVIEW_STATUSES)[number] {
  return intent === "approve" ? "approved" : intent === "reject" ? "rejected" : "proposed";
}

/**
 * The edit form (Batch 10): merge two items, move items to another silo, split a variant out of an item.
 * - merge: exactly two ids; the FIRST in table order is kept, the second is merged into it.
 * - move: at least one id and a target silo.
 * - split: `variant` is "<item uuid>|<variant text>" (one select per silo); no ids needed.
 */
export const EDIT_INTENTS = ["merge", "move", "split"] as const;
const editBase = z.object({ run: z.string().uuid(), gloss: z.enum(GLOSS_MODES).catch("off") });
export const editFormSchema = z.discriminatedUnion("intent", [
  editBase.extend({ intent: z.literal("merge"), ids: z.array(z.string().uuid()).length(2) }),
  editBase.extend({ intent: z.literal("move"), ids: z.array(z.string().uuid()).min(1).max(1000), silo: z.string().uuid() }),
  editBase.extend({ intent: z.literal("split"), item: z.string().uuid(), variant: z.string().trim().min(1).max(300) }),
]);
export type EditForm = z.infer<typeof editFormSchema>;

export function parseEditForm(fd: FormData): EditForm | null {
  const intent = String(fd.get("intent") ?? "");
  const ids = [...new Set(fd.getAll("id").map(String))];
  const base = { run: fd.get("run"), gloss: fd.get("gloss"), intent };
  let raw: unknown = null;
  if (intent === "merge") raw = { ...base, ids };
  else if (intent === "move") raw = { ...base, ids, silo: fd.get("silo") };
  else if (intent === "split") {
    const v = String(fd.get("variant") ?? "");
    const cut = v.indexOf("|");
    raw = { ...base, item: cut > 0 ? v.slice(0, cut) : "", variant: cut > 0 ? v.slice(cut + 1) : "" };
  }
  const p = editFormSchema.safeParse(raw);
  return p.success ? p.data : null;
}
