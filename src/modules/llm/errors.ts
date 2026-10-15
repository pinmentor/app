export type ProviderName = "anthropic" | "openai" | "gemini";

/** A failure of one provider attempt. Never carries a response body (it may echo prompts) or a key. */
export class ProviderError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(code: string, opts: { status?: number | null; retryable: boolean }) {
    super(code);
    this.name = "ProviderError";
    this.code = code;
    this.status = opts.status ?? null;
    this.retryable = opts.retryable;
  }
}

/** A failure of a whole `callLlm` (budget/kill-switch refusal, no route, or every model failed). */
export class LlmError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean) {
    super(code);
    this.name = "LlmError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function statusIsRetryable(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
