import { z } from "zod";

export const LOCALE_OPTIONS = ["es-MX", "es-US", "es-ES", "en-US"] as const;

/** Form of the "start a map run" action. Credits are held from the admin's own workspace: cost = 10 + 5 x ceil(n/25). */
export const startRunSchema = z
  .object({
    topic: z.string().trim().min(2).max(200),
    locale: z.enum(LOCALE_OPTIONS),
    targetMin: z.coerce.number().int().min(10).max(1000),
    targetMax: z.coerce.number().int().min(10).max(1000),
    mode: z.enum(["fast", "economy"]),
    key: z.string().min(8).max(100),
  })
  .refine((v) => v.targetMin <= v.targetMax, { message: "min > max" });

export function languageOf(locale: string): string {
  return locale.slice(0, 2);
}

export const runListRowSchema = z.object({
  id: z.string(),
  topic: z.string(),
  locale: z.string(),
  target_max: z.number(),
  status: z.string(),
  stage: z.string(),
  credit_amount: z.number(),
  candidates: z.coerce.number(),
  primaries: z.coerce.number(),
  last_error: z.string().nullable(),
  created_at: z.string(),
});
