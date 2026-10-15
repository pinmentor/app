export type ProviderRequest = {
  modelId: string;
  system?: string;
  prompt: string;
  maxOutputTokens: number;
  /** Omitted when the model does not support it (model_registry.supports_temperature = false). */
  temperature?: number;
  /** Ask the provider for JSON output where it has a switch for it. */
  json: boolean;
};

/** Token counts follow the conventions documented in ../cost.ts. */
export type ProviderResponse = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  requestId: string | null;
};

export type ProviderFn = (apiKey: string, req: ProviderRequest, signal: AbortSignal) => Promise<ProviderResponse>;
