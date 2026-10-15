import { z } from "zod";
import { ProviderError } from "../errors";
import { postJson } from "./http";
import type { ProviderFn } from "./types";

const responseSchema = z.object({
  candidates: z
    .array(z.object({ content: z.object({ parts: z.array(z.object({ text: z.string().optional() })).optional() }).optional() }))
    .optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
      thoughtsTokenCount: z.number().optional(),
      cachedContentTokenCount: z.number().optional(),
    })
    .optional(),
});

/** Gemini generateContent API. Unverified against the live API in this sandbox: confirm with the admin LLM test job. */
export const callGemini: ProviderFn = async (apiKey, req, signal) => {
  const { json, requestId } = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.modelId)}:generateContent`,
    { "x-goog-api-key": apiKey },
    {
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      generationConfig: {
        maxOutputTokens: req.maxOutputTokens,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.json ? { responseMimeType: "application/json" } : {}),
      },
    },
    signal,
  );

  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) throw new ProviderError("invalid_response", { retryable: true });

  const parts = parsed.data.candidates?.[0]?.content?.parts;
  if (!parts) throw new ProviderError("no_content", { retryable: false }); // e.g. blocked by safety filters

  const usage = parsed.data.usageMetadata;
  return {
    text: parts.map((p) => p.text ?? "").join(""),
    inputTokens: usage?.promptTokenCount ?? 0,
    // Gemini bills thinking tokens at the output price (see the model_registry note).
    outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    cachedInputTokens: usage?.cachedContentTokenCount ?? 0,
    requestId,
  };
};
