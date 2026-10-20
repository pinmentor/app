import { z } from "zod";

export const LOCALE_OPTIONS = ["es-MX", "es-US", "es-ES", "en-US"] as const;

export const SIZE_OPTIONS = ["auto", "custom"] as const;
export const DEFAULT_CEILING = 200;

/**
 * Form of the "start a map run" action. Size `auto`: the topic decides its own size and `targetMax` is only a CEILING
 * (the credit hold is for the ceiling, the charge is for the real size). Size `custom`: min and max are both targets.
 * Credits: 10 + 5 x ceil(n/25).
 */
export const startRunSchema = z
  .object({
    topic: z.string().trim().min(2).max(200),
    locale: z.enum(LOCALE_OPTIONS),
    size: z.enum(SIZE_OPTIONS).default("auto"),
    targetMin: z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : v), z.coerce.number().int().min(10).max(1000).optional()),
    targetMax: z.coerce.number().int().min(10).max(1000),
    mode: z.enum(["fast", "economy"]),
    key: z.string().min(8).max(100),
  })
  .refine((v) => v.size === "auto" || (v.targetMin !== undefined && v.targetMin <= v.targetMax), { message: "custom size needs min <= max" })
  .transform((v) => ({ ...v, targetMin: v.size === "auto" ? 10 : (v.targetMin as number) }));

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
