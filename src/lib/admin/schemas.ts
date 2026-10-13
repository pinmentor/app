import { z } from "zod";

export const MAX_CREDIT_ADJUSTMENT = 100_000;

/** Input of the admin "grant / revoke credits" form. */
export const creditAdjustSchema = z.object({
  workspaceId: z.uuid(),
  delta: z.coerce
    .number()
    .int()
    .refine((n) => n !== 0, "delta must not be 0")
    .refine((n) => Math.abs(n) <= MAX_CREDIT_ADJUSTMENT, "delta too large"),
  reason: z.string().trim().min(3).max(200),
  key: z.string().trim().min(8).max(100),
});

export type CreditAdjustInput = z.infer<typeof creditAdjustSchema>;

/** One row of admin_user_overview() (SQL function in migration 0004). */
export const userOverviewRowSchema = z.object({
  user_id: z.uuid(),
  email: z.string().nullable(),
  role: z.string(),
  suspended: z.boolean(),
  created_at: z.string(),
  last_sign_in_at: z.string().nullable(),
  workspace_id: z.uuid().nullable(),
  workspace_name: z.string().nullable(),
  credits_available: z.number().int(),
  credits_held: z.number().int(),
  total_count: z.number().int(),
});

export type UserOverviewRow = z.infer<typeof userOverviewRowSchema>;
