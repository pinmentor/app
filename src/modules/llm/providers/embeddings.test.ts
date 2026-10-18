import { describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS, parseGeminiEmbeddings, parseOpenAiEmbeddings } from "./embeddings";

const vec = (x: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? x : 0));

describe("embedding response parsing", () => {
  it("OpenAI: restores input order by index and reads token usage", () => {
    const r = parseOpenAiEmbeddings({ data: [{ index: 1, embedding: vec(2) }, { index: 0, embedding: vec(1) }], usage: { prompt_tokens: 7, total_tokens: 7 } }, 2);
    expect(r.vectors.map((v) => v[0])).toEqual([1, 2]);
    expect(r.inputTokens).toBe(7);
  });
  it("rejects a wrong count, wrong dimension, non-finite numbers and junk", () => {
    expect(() => parseOpenAiEmbeddings({ data: [{ index: 0, embedding: vec(1) }] }, 2)).toThrow();
    expect(() => parseOpenAiEmbeddings({ data: [{ index: 0, embedding: [1, 2, 3] }] }, 1)).toThrow();
    expect(() => parseOpenAiEmbeddings({ nope: true }, 1)).toThrow();
    expect(() => parseGeminiEmbeddings({ embeddings: [{ values: [1, 2] }] }, 1)).toThrow();
  });
  it("Gemini: reads values in order", () => {
    expect(parseGeminiEmbeddings({ embeddings: [{ values: vec(3) }, { values: vec(4) }] }, 2).map((v) => v[0])).toEqual([3, 4]);
  });
});
