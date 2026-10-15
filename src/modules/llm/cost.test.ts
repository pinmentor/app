import { describe, expect, it } from "vitest";
import { computeCostUsd, type PriceRow } from "./cost";

const base: PriceRow = {
  input_usd_per_mtok: 2,
  output_usd_per_mtok: 10,
  cached_input_usd_per_mtok: 0.1,
  long_context_threshold: null,
  long_input_usd_per_mtok: null,
  long_output_usd_per_mtok: null,
  long_cached_input_usd_per_mtok: null,
};

const haikuLike: PriceRow = {
  input_usd_per_mtok: 0.1,
  output_usd_per_mtok: 0.5,
  cached_input_usd_per_mtok: 0.01,
  long_context_threshold: 100_000,
  long_input_usd_per_mtok: 0.5,
  long_output_usd_per_mtok: 2.5,
  long_cached_input_usd_per_mtok: 0.05,
};

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

describe("computeCostUsd", () => {
  it("prices input and output per million tokens", () => {
    expect(computeCostUsd({ inputTokens: 1e6, outputTokens: 1e6, cachedInputTokens: 0 }, base)).toBe(12);
    expect(computeCostUsd({ inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0 }, base)).toBe(0.007);
  });

  it("bills cached tokens at the cached rate", () => {
    expect(computeCostUsd({ inputTokens: 1e6, outputTokens: 0, cachedInputTokens: 4e5 }, base)).toBe(1.24);
  });

  it("bills cached tokens as normal input when there is no cached rate", () => {
    expect(computeCostUsd({ inputTokens: 1e6, outputTokens: 0, cachedInputTokens: 4e5 }, { ...base, cached_input_usd_per_mtok: null })).toBe(2);
  });

  it("uses the long-context tier only ABOVE the threshold", () => {
    expect(computeCostUsd({ inputTokens: 100_000, outputTokens: 0, cachedInputTokens: 0 }, haikuLike)).toBe(0.01);
    expect(computeCostUsd({ inputTokens: 100_001, outputTokens: 1000, cachedInputTokens: 0 }, haikuLike)).toBe(
      round6((100_001 * 0.5 + 1000 * 2.5) / 1e6),
    );
  });

  it("uses the long cached rate in the long tier", () => {
    expect(computeCostUsd({ inputTokens: 200_000, outputTokens: 0, cachedInputTokens: 100_000 }, haikuLike)).toBe(
      round6((100_000 * 0.5 + 100_000 * 0.05) / 1e6),
    );
  });

  it("clamps cached > input and treats garbage counts as zero", () => {
    expect(computeCostUsd({ inputTokens: 100, outputTokens: 0, cachedInputTokens: 999 }, base)).toBe(round6((100 * 0.1) / 1e6));
    expect(computeCostUsd({ inputTokens: NaN, outputTokens: -5, cachedInputTokens: Infinity }, base)).toBe(0);
  });
});
