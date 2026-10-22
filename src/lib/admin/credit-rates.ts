import { z } from "zod";

/** /admin/credits: form and report schemas. The price itself is never decided in code; only a superadmin sets it. */

export const RATE_ACTION = /^[a-z][a-z0-9_.]{1,63}$/;
export const MAX_RATE = 100_000;

/** Actions the app knows how to charge, shown with a plain explanation. Others (test_job, ...) are listed as found. */
export const KNOWN_RATES: Record<string, { label: string; unit: string }> = {
  article_write: { label: "Write one article", unit: "credits per article that comes out ready (a failed or canceled article is free)" },
  test_job: { label: "Test job (admin plumbing test)", unit: "credits per test job" },
};

export const rateFormSchema = z.object({
  action: z.string().trim().regex(RATE_ACTION),
  credits: z
    .string()
    .trim()
    .regex(/^\d{1,6}$/)
    .transform(Number)
    .refine((n) => n <= MAX_RATE),
  note: z
    .string()
    .trim()
    .max(200)
    .transform((s) => (s === "" ? null : s)),
});
export type RateForm = z.infer<typeof rateFormSchema>;

export function parseRateForm(raw: Record<string, unknown>): RateForm | null {
  const r = rateFormSchema.safeParse({ action: raw.action, credits: raw.credits, note: raw.note ?? "" });
  return r.success ? r.data : null;
}
export const parseRateAction = (raw: unknown): string | null => {
  const r = z.string().trim().regex(RATE_ACTION).safeParse(raw);
  return r.success ? r.data : null;
};

export const rateRowSchema = z.object({ action: z.string(), credits: z.number().int(), note: z.string().nullable().optional(), updated_at: z.string() });
export type RateRow = z.infer<typeof rateRowSchema>;

const num = z.coerce.number();
export const taskCostRowSchema = z.object({
  task: z.string(), ok_calls: num, failed_calls: num, avg_input_tok: num.nullable(), avg_output_tok: num.nullable(), avg_cost_usd: num.nullable(), total_cost_usd: num.nullable(),
});
export const articleCostRowSchema = z.object({
  status: z.string(), articles: num, avg_calls: num.nullable(), avg_input_tok: num.nullable(), avg_output_tok: num.nullable(),
  avg_cost_usd: num.nullable(), min_cost_usd: num.nullable(), max_cost_usd: num.nullable(), total_cost_usd: num.nullable(),
});

export const usd = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `$${n.toFixed(n !== 0 && Math.abs(n) < 0.1 ? 4 : 2)}`);
export const tokens = (n: number | null | undefined) => (n === null || n === undefined ? "—" : Math.round(n).toLocaleString("en-US"));
