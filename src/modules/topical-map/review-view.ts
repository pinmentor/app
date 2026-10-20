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

export const ITEM_STATUSES = ["draft", "approved", "rejected"] as const;

export function statusCounts(statuses: string[]): Record<(typeof ITEM_STATUSES)[number], number> {
  const out = { draft: 0, approved: 0, rejected: 0 };
  for (const s of statuses) if (s === "draft" || s === "approved" || s === "rejected") out[s] += 1;
  return out;
}

/** The review form: which items, what to do. `approve_clean` needs no ids. */
export const REVIEW_INTENTS = ["approve", "reject", "draft", "approve_clean"] as const;
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
export function statusForIntent(intent: "approve" | "reject" | "draft"): (typeof ITEM_STATUSES)[number] {
  return intent === "approve" ? "approved" : intent === "reject" ? "rejected" : "draft";
}
