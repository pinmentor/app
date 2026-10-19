import { z } from "zod";
import { cleanLabel, shortText, tolerantList, withKeys } from "./tolerant";

export const verdictSchema = z.enum(["same", "parent_child", "related", "different"]);

export const candidateSchema = z.object({
  /** Display text, accents kept. */
  raw: z.string().min(1).max(200),
  source: z.string().min(1).max(40).default("manual"),
  facet: z.string().max(80).optional(),
  /** 1 (weak) .. 5 (strong) LLM-signal estimate; never a made-up search volume (PLAN 3.7). */
  demandTier: z.number().int().min(1).max(5).optional(),
});
export type Candidate = z.infer<typeof candidateSchema>;

export const goldPairSchema = z.object({
  id: z.string(),
  language: z.literal("es"),
  locale: z.string(),
  a: z.string().min(1),
  b: z.string().min(1),
  label: z.enum(["same", "parent_child", "related", "different", "uncertain"]),
  /** dev = used for tuning, test = only for reporting. Never tune on test. */
  split: z.enum(["dev", "test"]),
  /** provisional = one labeler, not yet confirmed by the two-model + SERP protocol (PLAN 3.10). */
  status: z.enum(["provisional", "confirmed"]),
  labeledBy: z.string(),
  note: z.string().optional(),
});
export type GoldPair = z.infer<typeof goldPairSchema>;

export const judgeItemSchema = withKeys(["reason"], z.object({
  i: z.coerce.number().int().min(0),
  verdict: z.preprocess(cleanLabel, verdictSchema),
  reason: z.unknown().transform(shortText(300)),
}));
/** Tolerant: an item with an unknown verdict is dropped and the caller keeps that pair separate (never a guessed merge). */
export const judgeResponseSchema = tolerantList(judgeItemSchema);
