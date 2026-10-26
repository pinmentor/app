import { z } from "zod";
import { LlmError } from "@/modules/llm/errors";
import { callLlm } from "@/modules/llm/client";

import { JobError, type JobContext, type JobHandler } from "./types";
import { mapHandlers } from "@/modules/topical-map/stages";
import { articleHandlers } from "@/modules/articles/handlers";
import { pinHandlers } from "@/modules/pins/handlers";

export { JobError };
export type { JobContext, JobHandler };

const noopPayload = z.object({ mode: z.enum(["ok", "fail", "fail_permanent"]) });
const echoSchema = z.object({ echo: z.string().max(200) });

/**
 * Registry of job types. Handlers must be idempotent and finish in well under 60s (CLAUDE.md);
 * anything longer is split into chunked, resumable stages that enqueue their successors.
 */
export const handlers: Record<string, JobHandler> = {
  // Plumbing test: no LLM, no credits.
  "test.noop": async (ctx) => {
    const p = noopPayload.safeParse(ctx.payload);
    if (!p.success) throw new JobError("invalid payload", "invalid_payload", { retryable: false });
    if (p.data.mode === "fail") throw new JobError("simulated failure", "test_failure", { retryable: true, retryAfterSeconds: 0 });
    if (p.data.mode === "fail_permanent") throw new JobError("simulated permanent failure", "test_failure_permanent", { retryable: false });
    return { ok: true };
  },

  // End-to-end test: credit hold -> real LLM call through the router -> cost log -> credit commit.
  "test.llm_echo": async (ctx) => {
    const r = await callLlm({
      task: "test_echo",
      workspaceId: ctx.workspaceId,
      jobId: ctx.jobId,
      prompt: 'Reply with exactly this JSON and nothing else: {"echo":"pong"}',
      schema: echoSchema,
      maxOutputTokens: 100,
      temperature: 0,
    });
    return { echo: r.data.echo, model_key: r.modelKey, cost_usd: r.costUsd };
  },

  // Topical-map stages (S1-S4): src/modules/topical-map/stages.ts
  ...mapHandlers,

  // Article writer (outline -> sections -> assemble): src/modules/articles/handlers.ts
  ...articleHandlers,
  ...pinHandlers,
};

/** Maps any thrown value to the fields job_fail() needs. Messages are sanitised: no prompts, payloads or keys. */
export function describeFailure(e: unknown): { message: string; code: string; retryable: boolean; retryAfterSeconds: number | null } {
  if (e instanceof JobError) {
    return { message: e.message, code: e.code, retryable: e.retryable, retryAfterSeconds: e.retryAfterSeconds };
  }
  if (e instanceof LlmError) {
    return { message: `LLM call failed: ${e.code}`, code: e.code, retryable: e.retryable, retryAfterSeconds: null };
  }
  const name = e instanceof Error ? e.name : "unknown";
  return { message: `unexpected error (${name})`, code: "unexpected", retryable: true, retryAfterSeconds: null };
}
