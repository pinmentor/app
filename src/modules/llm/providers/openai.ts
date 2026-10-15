import { z } from "zod";
import { ProviderError } from "../errors";
import { postJson } from "./http";
import type { ProviderFn } from "./types";

const responseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    prompt_tokens_details: z.object({ cached_tokens: z.number().nullish() }).nullish(),
  }),
});

/** OpenAI Chat Completions API. Unverified against the live API in this sandbox: confirm with the admin LLM test job. */
export const callOpenAi: ProviderFn = async (apiKey, req, signal) => {
  const messages = [
    ...(req.system ? [{ role: "system", content: req.system }] : []),
    { role: "user", content: req.prompt },
  ];
  const { json, requestId } = await postJson(
    "https://api.openai.com/v1/chat/completions",
    { authorization: `Bearer ${apiKey}` },
    {
      model: req.modelId,
      messages,
      max_completion_tokens: req.maxOutputTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
    },
    signal,
  );

  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) throw new ProviderError("invalid_response", { retryable: true });

  const first = parsed.data.choices[0];
  return {
    text: first?.message.content ?? "",
    inputTokens: parsed.data.usage.prompt_tokens,
    outputTokens: parsed.data.usage.completion_tokens,
    cachedInputTokens: parsed.data.usage.prompt_tokens_details?.cached_tokens ?? 0,
    requestId,
  };
};
