/**
 * Pure cost maths for one LLM call. No imports on purpose (unit-testable anywhere).
 *
 * Token conventions (every provider adapter normalises to these):
 *  - inputTokens        = ALL prompt tokens, including cached ones
 *  - cachedInputTokens  = the part of inputTokens served from the provider's prompt cache
 *  - outputTokens       = everything billed as output (incl. thinking/reasoning tokens)
 * Prices are USD per 1,000,000 tokens and come from `model_prices` (never hardcoded here).
 */
export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

export type PriceRow = {
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
  cached_input_usd_per_mtok: number | null;
  long_context_threshold: number | null;
  long_input_usd_per_mtok: number | null;
  long_output_usd_per_mtok: number | null;
  long_cached_input_usd_per_mtok: number | null;
};

const PER_MTOK = 1_000_000;

function nonNegativeInt(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** USD cost rounded to 6 decimals (matches llm_calls.cost_usd numeric(12,6)). */
export function computeCostUsd(usage: Usage, price: PriceRow): number {
  const input = nonNegativeInt(usage.inputTokens);
  const output = nonNegativeInt(usage.outputTokens);
  const cached = Math.min(nonNegativeInt(usage.cachedInputTokens), input);

  // "prompts ABOVE this use the long_* prices"
  const useLong =
    price.long_context_threshold !== null &&
    price.long_input_usd_per_mtok !== null &&
    price.long_output_usd_per_mtok !== null &&
    input > price.long_context_threshold;

  const inRate = useLong ? (price.long_input_usd_per_mtok as number) : price.input_usd_per_mtok;
  const outRate = useLong ? (price.long_output_usd_per_mtok as number) : price.output_usd_per_mtok;
  // A missing cached rate means "bill cached tokens as normal input".
  const cachedRate = useLong
    ? (price.long_cached_input_usd_per_mtok ?? inRate)
    : (price.cached_input_usd_per_mtok ?? inRate);

  const usd = ((input - cached) * inRate + cached * cachedRate + output * outRate) / PER_MTOK;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
