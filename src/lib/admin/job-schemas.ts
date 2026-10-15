import { z } from "zod";

export const JOB_STATES = ["queued", "running", "succeeded", "dead", "canceled"] as const;
export const stateFilterSchema = z.enum(["all", ...JOB_STATES]).catch("all");

export const jobActionSchema = z.object({ jobId: z.uuid() });

export const testJobSchema = z.object({
  mode: z.enum(["llm", "ok", "fail", "fail_permanent"]),
  key: z.string().trim().min(8).max(100),
});

export const jobCountRowSchema = z.object({
  state: z.string(),
  jobs: z.number().int(),
  oldest_run_at: z.string().nullable(),
});

export const jobRowSchema = z.object({
  id: z.uuid(),
  workspace_id: z.uuid(),
  type: z.string(),
  state: z.string(),
  attempts: z.number().int(),
  max_attempts: z.number().int(),
  retry_count: z.number().int(),
  credit_amount: z.number().int(),
  last_error: z.string().nullable(),
  last_error_code: z.string().nullable(),
  run_at: z.string(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});
export type JobRow = z.infer<typeof jobRowSchema>;

export const llmUsageRowSchema = z.object({
  provider: z.string(),
  model_key: z.string(),
  calls: z.number().int(),
  errors: z.number().int(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cost_usd: z.number(),
  avg_latency_ms: z.number(),
});

export const budgetRowSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().nullable(),
  spent_today_usd: z.number(),
  daily_limit_usd: z.number().nullable(),
});
