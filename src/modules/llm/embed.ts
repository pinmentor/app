import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { budgetRowSchema, logAttempt, resolveKeys, routeRowSchema, toPrice } from "./client";
import { computeCostUsd } from "./cost";
import { LlmError, ProviderError, type ProviderName } from "./errors";
import { embedGemini, embedOpenAi, type EmbedProviderFn } from "./providers/embeddings";

/**
 * The embedding door. Same rules as callLlm: kill switch + budget first, route and price from the DB registry
 * (task `embedding`), key from the secrets resolver, one llm_calls row per attempt. Credits are held by the map run,
 * not here.
 */
const PROVIDERS: Record<ProviderName, EmbedProviderFn | null> = {
  openai: embedOpenAi,
  gemini: embedGemini,
  anthropic: null, // Anthropic has no embedding API
};

const BATCH = 128;
const TIMEOUT_MS = 40_000;

export type EmbedResult = { vectors: number[][]; modelKey: string; costUsd: number };

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export async function embedTexts(req: { workspaceId: string; jobId?: string | null; texts: string[] }): Promise<EmbedResult> {
  if (req.texts.length === 0) return { vectors: [], modelKey: "", costUsd: 0 };
  const sb = createAdminClient();

  const budgetRes = await sb.rpc("llm_budget_check");
  const budget = z.array(budgetRowSchema).min(1).safeParse(budgetRes.data);
  if (budgetRes.error || !budget.success) throw new LlmError("budget_check_failed", true);
  const gate = budget.data[0];
  if (gate && !gate.allowed) throw new LlmError(gate.reason ?? "refused", false);

  const routeRes = await sb.rpc("llm_route_models", { p_task: "embedding" });
  const routes = z.array(routeRowSchema).safeParse(routeRes.data);
  if (routeRes.error || !routes.success) throw new LlmError("route_lookup_failed", true);

  const keys = await resolveKeys(routes.data.map((r) => r.provider));
  const candidates = routes.data.filter((r) => keys.has(r.provider) && PROVIDERS[r.provider] !== null);
  if (candidates.length === 0) throw new LlmError("no_route", false);

  // A whole request goes to ONE model: vectors from different models must never be mixed in one run
  // (cosine thresholds and distances are only meaningful inside one embedding space).
  let anyRetryable = false;
  let attempt = 0;
  for (const route of candidates) {
    attempt += 1;
    const started = Date.now();
    const key = keys.get(route.provider);
    const fn = PROVIDERS[route.provider];
    if (!key || !fn) continue;

    try {
      const vectors: number[][] = [];
      let tokens = 0;
      for (const part of chunks(req.texts, BATCH)) {
        const r = await fn(key, { modelId: route.model_id, texts: part }, AbortSignal.timeout(TIMEOUT_MS));
        vectors.push(...r.vectors);
        tokens += r.inputTokens;
      }
      const costUsd = computeCostUsd({ inputTokens: tokens, outputTokens: 0, cachedInputTokens: 0 }, toPrice(route));
      await logAttempt({
        workspaceId: req.workspaceId, jobId: req.jobId ?? null, task: "embedding", route, attempt, status: "ok",
        usage: { inputTokens: tokens, outputTokens: 0, cachedInputTokens: 0 }, costUsd, latencyMs: Date.now() - started,
      });
      return { vectors, modelKey: route.model_key, costUsd };
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError("unexpected", { retryable: true });
      anyRetryable = anyRetryable || pe.retryable;
      await logAttempt({
        workspaceId: req.workspaceId, jobId: req.jobId ?? null, task: "embedding", route, attempt, status: "error",
        errorCode: pe.code, httpStatus: pe.status, latencyMs: Date.now() - started,
      });
    }
  }
  throw new LlmError("all_models_failed", anyRetryable);
}
