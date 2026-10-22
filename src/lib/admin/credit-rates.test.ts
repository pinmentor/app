import { describe, expect, it } from "vitest";
import { articleCostRowSchema, parseRateAction, parseRateForm, usd } from "./credit-rates";

describe("parseRateForm", () => {
  it("accepts a normal price and trims the note", () => {
    expect(parseRateForm({ action: "article_write", credits: " 12 ", note: "  first guess " })).toEqual({ action: "article_write", credits: 12, note: "first guess" });
  });
  it("accepts 0 (free) and an empty note", () => {
    expect(parseRateForm({ action: "article_write", credits: "0" })).toEqual({ action: "article_write", credits: 0, note: null });
  });
  it("rejects bad action, negative, decimal, huge and text prices", () => {
    expect(parseRateForm({ action: "Bad Action", credits: "1" })).toBe(null);
    expect(parseRateForm({ action: "article_write", credits: "-1" })).toBe(null);
    expect(parseRateForm({ action: "article_write", credits: "1.5" })).toBe(null);
    expect(parseRateForm({ action: "article_write", credits: "100001" })).toBe(null);
    expect(parseRateForm({ action: "article_write", credits: "abc" })).toBe(null);
    expect(parseRateForm({ action: "article_write", credits: "5", note: "x".repeat(201) })).toBe(null);
  });
});

describe("helpers", () => {
  it("parses actions", () => {
    expect(parseRateAction("article_write")).toBe("article_write");
    expect(parseRateAction("../x")).toBe(null);
  });
  it("reads numeric strings from Postgres", () => {
    const r = articleCostRowSchema.parse({ status: "ready", articles: "3", avg_calls: "5.0", avg_input_tok: null, avg_output_tok: "100", avg_cost_usd: "0.0123", min_cost_usd: "0.01", max_cost_usd: "0.02", total_cost_usd: "0.0369" });
    expect(r.articles).toBe(3);
    expect(r.avg_cost_usd).toBe(0.0123);
  });
  it("formats money", () => {
    expect(usd(null)).toBe("—");
    expect(usd(0.0123)).toBe("$0.0123");
    expect(usd(1.5)).toBe("$1.50");
    expect(usd(0)).toBe("$0.00");
  });
});
