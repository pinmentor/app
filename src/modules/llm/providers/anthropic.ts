import { z } from "zod";
import { ProviderError } from "../errors";
import { postJson } from "./http";
import type { ProviderFn } from "./types";

const responseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_read_input_tokens: z.number().nullish(),
    cache_creation_input_tokens: z.number().nullish(),
  }),
});

/** Anthropic Messages API. Unverified against the live API in this sandbox: confirm with the admin LLM test job. */
export const callAnthropic: ProviderFn = async (apiKey, req, signal) => {
  const { json, requestId } = await postJson(
    "https://api.anthropic.com/v1/messages",
    { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    {
      model: req.modelId,
      max_tokens: req.maxOutputTokens,
      ...(req.system ? { system: req.system } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      messages: [{ role: "user", content: req.prompt }],
    },
    signal,
  );

  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) throw new ProviderError("invalid_response", { retryable: true });

  const text = parsed.data.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
  const cacheRead = parsed.data.usage.cache_read_input_tokens ?? 0;
  const cacheWrite = parsed.data.usage.cache_creation_input_tokens ?? 0;
  return {
    text,
    // Anthropic reports fresh input separately from cache reads/writes; we normalise to "all prompt tokens".
    inputTokens: parsed.data.usage.input_tokens + cacheRead + cacheWrite,
    outputTokens: parsed.data.usage.output_tokens,
    cachedInputTokens: cacheRead,
    requestId,
  };
};
