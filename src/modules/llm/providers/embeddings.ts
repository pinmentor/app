import { z } from "zod";
import { ProviderError } from "../errors";
import { postJson } from "./http";

/** Dimension of kw_candidates.embedding (vector(1536), migration 0009). Providers are asked for exactly this size. */
export const EMBEDDING_DIMENSIONS = 1536;

export type EmbedRequest = { modelId: string; texts: string[] };
export type EmbedResponse = { vectors: number[][]; inputTokens: number; requestId: string | null };
export type EmbedProviderFn = (apiKey: string, req: EmbedRequest, signal: AbortSignal) => Promise<EmbedResponse>;

const vectorSchema = z.array(z.number().finite());

const openAiSchema = z.object({
  data: z.array(z.object({ index: z.number().int(), embedding: vectorSchema })),
  usage: z.object({ prompt_tokens: z.number().optional(), total_tokens: z.number().optional() }).optional(),
});

/** Validates a provider response: right count, right order, right dimension, finite numbers. Never trusts the body. */
export function checkVectors(vectors: number[][], count: number): number[][] {
  if (vectors.length !== count) throw new ProviderError("invalid_response", { retryable: true });
  for (const v of vectors) if (v.length !== EMBEDDING_DIMENSIONS) throw new ProviderError("wrong_dimension", { retryable: false });
  return vectors;
}

export function parseOpenAiEmbeddings(json: unknown, count: number): { vectors: number[][]; inputTokens: number } {
  const parsed = openAiSchema.safeParse(json);
  if (!parsed.success) throw new ProviderError("invalid_response", { retryable: true });
  const ordered = [...parsed.data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  return {
    vectors: checkVectors(ordered, count),
    inputTokens: parsed.data.usage?.prompt_tokens ?? parsed.data.usage?.total_tokens ?? 0,
  };
}

/** OpenAI POST /v1/embeddings (request/response shape read from the API reference 2026-10-17; not yet run live). */
export const embedOpenAi: EmbedProviderFn = async (apiKey, req, signal) => {
  const { json, requestId } = await postJson(
    "https://api.openai.com/v1/embeddings",
    { authorization: `Bearer ${apiKey}` },
    { model: req.modelId, input: req.texts, dimensions: EMBEDDING_DIMENSIONS, encoding_format: "float" },
    signal,
  );
  const { vectors, inputTokens } = parseOpenAiEmbeddings(json, req.texts.length);
  return { vectors, inputTokens, requestId };
};

const geminiSchema = z.object({ embeddings: z.array(z.object({ values: vectorSchema })) });

export function parseGeminiEmbeddings(json: unknown, count: number): number[][] {
  const parsed = geminiSchema.safeParse(json);
  if (!parsed.success) throw new ProviderError("invalid_response", { retryable: true });
  return checkVectors(
    parsed.data.embeddings.map((e) => e.values),
    count,
  );
}

/**
 * Gemini batchEmbedContents. UNVERIFIED live: the docs show the request but not the raw REST response, and the response
 * carries no token count, so tokens are estimated (chars / 4). That is why the Gemini embedding model ships disabled
 * (no verified price) in migration 0008.
 */
export const embedGemini: EmbedProviderFn = async (apiKey, req, signal) => {
  const { json, requestId } = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.modelId)}:batchEmbedContents`,
    { "x-goog-api-key": apiKey },
    {
      requests: req.texts.map((text) => ({
        model: `models/${req.modelId}`,
        content: { parts: [{ text }] },
        output_dimensionality: EMBEDDING_DIMENSIONS,
      })),
    },
    signal,
  );
  const vectors = parseGeminiEmbeddings(json, req.texts.length);
  const inputTokens = Math.ceil(req.texts.reduce((n, t) => n + t.length, 0) / 4);
  return { vectors, inputTokens, requestId };
};
