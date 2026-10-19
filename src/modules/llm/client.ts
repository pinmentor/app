import { z } from "zod";
import { getProviderKey } from "@/lib/secrets/resolve";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeCostUsd, type PriceRow, type Usage } from "./cost";
import { LlmError, ProviderError, type ProviderName } from "./errors";
import { extractJson, invalidReason } from "./json";
import { callAnthropic } from "./providers/anthropic";
import { callGemini } from "./providers/gemini";
import { callOpenAi } from "./providers/openai";
import type { ProviderFn, ProviderResponse } from "./providers/types";

/**
 * The ONLY door to an LLM (CLAUDE.md). It:
 *  1. refuses the call when the kill switch is on or today's budget is spent (llm_budget_check),
 *  2. resolves the task's fallback chain from the DB (llm_route_models: model ids + effective-dated prices live there),
 *  3. tries each model in order, validating the output with the caller's Zod schema,
 *  4. writes one `llm_calls` row per attempt (tokens, cost, latency, error code), success or not.
 * Credits are NOT charged here: the job that calls this holds/commits credits (see job_enqueue / job_complete).
 */

const PROVIDERS: Record<ProviderName, { call: ProviderFn }> = {
  anthropic: { call: callAnthropic },
  openai: { call: callOpenAi },
  gemini: { call: callGemini },
};

// numeric columns may arrive as numbers or strings depending on the PostgREST path; accept both
const numLike = z.preprocess((v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v), z.number());

export const routeRowSchema = z.object({
  pos: z.number().int(),
  model_key: z.string(),
  provider: z.enum(["anthropic", "openai", "gemini"]),
  model_id: z.string(),
  max_output_tokens: z.number().int().nullable(),
  supports_temperature: z.boolean(),
  price_effective_from: z.string(),
  input_usd_per_mtok: numLike,
  output_usd_per_mtok: numLike,
  cached_input_usd_per_mtok: numLike.nullable(),
  long_context_threshold: z.number().int().nullable(),
  long_input_usd_per_mtok: numLike.nullable(),
  long_output_usd_per_mtok: numLike.nullable(),
  long_cached_input_usd_per_mtok: numLike.nullable(),
});
export type RouteRow = z.infer<typeof routeRowSchema>;

export const budgetRowSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().nullable(),
});

export type LlmRequest<S extends z.ZodType> = {
  /** Key of `llm_routes.task`, e.g. "facet_generation". */
  task: string;
  workspaceId: string;
  jobId?: string | null;
  prompt: string;
  system?: string;
  /** Zod schema the model's JSON output must satisfy. Invalid output is never returned. */
  schema: S;
  maxOutputTokens?: number;
  temperature?: number;
  /** Cross-judge tasks: never use this provider (a different model must judge than produced). */
  avoidProvider?: ProviderName;
  /** Per-attempt timeout. Keep well under the 60s step limit (CLAUDE.md). */
  timeoutMs?: number;
};

export type LlmResult<T> = {
  data: T;
  modelKey: string;
  provider: ProviderName;
  modelId: string;
  usage: Usage;
  costUsd: number;
};

const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 40_000;

export function toPrice(r: RouteRow): PriceRow {
  return {
    input_usd_per_mtok: r.input_usd_per_mtok,
    output_usd_per_mtok: r.output_usd_per_mtok,
    cached_input_usd_per_mtok: r.cached_input_usd_per_mtok,
    long_context_threshold: r.long_context_threshold,
    long_input_usd_per_mtok: r.long_input_usd_per_mtok,
    long_output_usd_per_mtok: r.long_output_usd_per_mtok,
    long_cached_input_usd_per_mtok: r.long_cached_input_usd_per_mtok,
  };
}

/** Keys come from the encrypted admin page first, then env vars (src/lib/secrets). Resolved once per call. */
export async function resolveKeys(providers: ProviderName[]): Promise<Map<ProviderName, string>> {
  const keys = new Map<ProviderName, string>();
  for (const p of new Set(providers)) {
    const key = await getProviderKey(p);
    if (key && key.length >= 10) keys.set(p, key);
  }
  return keys;
}

export type AttemptLog = {
  workspaceId: string;
  jobId: string | null;
  task: string;
  route: RouteRow;
  attempt: number;
  status: "ok" | "error" | "invalid_output";
  errorCode?: string;
  httpStatus?: number | null;
  usage?: Usage;
  costUsd?: number;
  latencyMs: number;
  requestId?: string | null;
};

export async function logAttempt(l: AttemptLog): Promise<void> {
  try {
    const { error } = await createAdminClient()
      .from("llm_calls")
      .insert({
        workspace_id: l.workspaceId,
        job_id: l.jobId,
        task: l.task,
        provider: l.route.provider,
        model_key: l.route.model_key,
        model_id: l.route.model_id,
        attempt: l.attempt,
        status: l.status,
        error_code: l.errorCode ?? null,
        http_status: l.httpStatus ?? null,
        input_tokens: l.usage?.inputTokens ?? 0,
        output_tokens: l.usage?.outputTokens ?? 0,
        cached_input_tokens: l.usage?.cachedInputTokens ?? 0,
        cost_usd: l.costUsd ?? 0,
        price_effective_from: l.route.price_effective_from,
        latency_ms: l.latencyMs,
        provider_request_id: l.requestId ?? null,
        byok: false,
      });
    if (error) console.error("llm_calls insert failed:", error.code ?? "no_code");
  } catch {
    console.error("llm_calls insert failed: unexpected");
  }
}

export async function callLlm<S extends z.ZodType>(req: LlmRequest<S>): Promise<LlmResult<z.output<S>>> {
  const sb = createAdminClient();

  // 1) kill switch / daily budget
  const budgetRes = await sb.rpc("llm_budget_check");
  const budget = z.array(budgetRowSchema).min(1).safeParse(budgetRes.data);
  if (budgetRes.error || !budget.success) throw new LlmError("budget_check_failed", true);
  const gate = budget.data[0];
  if (gate && !gate.allowed) throw new LlmError(gate.reason ?? "refused", false);

  // 2) route
  const routeRes = await sb.rpc("llm_route_models", { p_task: req.task });
  const routes = z.array(routeRowSchema).safeParse(routeRes.data);
  if (routeRes.error || !routes.success) throw new LlmError("route_lookup_failed", true);

  const keys = await resolveKeys(routes.data.map((r) => r.provider));
  const candidates = routes.data.filter((r) => r.provider !== req.avoidProvider && keys.has(r.provider));
  if (candidates.length === 0) throw new LlmError("no_route", false);

  // 3) try the chain in order
  let anyRetryable = false;
  let attempt = 0;

  for (const route of candidates) {
    attempt += 1;
    const started = Date.now();
    const key = keys.get(route.provider);
    if (!key) continue;

    const maxOut = Math.min(req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, route.max_output_tokens ?? Number.MAX_SAFE_INTEGER);
    const signal = AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let resp: ProviderResponse;
    try {
      resp = await PROVIDERS[route.provider].call(
        key,
        {
          modelId: route.model_id,
          system: req.system,
          prompt: req.prompt,
          maxOutputTokens: maxOut,
          temperature: route.supports_temperature ? req.temperature : undefined,
          json: true,
        },
        signal,
      );
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError("unexpected", { retryable: true });
      anyRetryable = anyRetryable || pe.retryable;
      await logAttempt({
        workspaceId: req.workspaceId,
        jobId: req.jobId ?? null,
        task: req.task,
        route,
        attempt,
        status: "error",
        errorCode: pe.code,
        httpStatus: pe.status,
        latencyMs: Date.now() - started,
      });
      continue;
    }

    const usage: Usage = {
      inputTokens: resp.inputTokens,
      outputTokens: resp.outputTokens,
      cachedInputTokens: resp.cachedInputTokens,
    };
    const costUsd = computeCostUsd(usage, toPrice(route));
    const latencyMs = Date.now() - started;

    // 4) validate the output: the call is billed either way, so it is logged either way
    const extracted = extractJson(resp.text);
    const validated = extracted.ok ? req.schema.safeParse(extracted.value) : null;

    if (validated?.success) {
      await logAttempt({ workspaceId: req.workspaceId, jobId: req.jobId ?? null, task: req.task, route, attempt, status: "ok", usage, costUsd, latencyMs, requestId: resp.requestId });
      return {
        data: validated.data as z.output<S>,
        modelKey: route.model_key,
        provider: route.provider,
        modelId: route.model_id,
        usage,
        costUsd,
      };
    }

    anyRetryable = true; // a re-run may well produce valid output
    await logAttempt({ workspaceId: req.workspaceId, jobId: req.jobId ?? null, task: req.task, route, attempt, status: "invalid_output", errorCode: invalidReason(resp.text, resp.outputTokens, maxOut, extracted.ok), usage, costUsd, latencyMs, requestId: resp.requestId });
  }

  throw new LlmError("all_models_failed", anyRetryable);
}
