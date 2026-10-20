import { describe, expect, it } from "vitest";
import { chunk, decideAdvance, embeddingModelCheck, expansionCallCount, judgeSlots, planExpansion, ranges } from "./plan";
import { LIMITS, thresholdsFor, REAL_EMBEDDER_THRESHOLDS } from "./stage-config";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const facets = [
  { id: id(1), name: "occasion", values: ["boda", "graduación", "fiesta"] },
  { id: id(2), name: "length", values: ["corto", "largo"] },
  { id: id(3), name: "tool", values: ["plancha"] },
];

describe("expansion planning", () => {
  it("scales calls with the target and keeps them bounded", () => {
    expect(expansionCallCount(10)).toBe(6);
    expect(expansionCallCount(100)).toBe(20);
    expect(expansionCallCount(500)).toBe(100);
    expect(expansionCallCount(1000)).toBe(150);
  });
  it("walks facets round-robin, ends with one questions task, never repeats a value", () => {
    const tasks = planExpansion(facets, 500);
    const values = tasks.filter((t) => t.kind === "value").map((t) => (t.kind === "value" ? `${t.facet}:${t.value}` : ""));
    expect(values).toEqual(["occasion:boda", "length:corto", "tool:plancha", "occasion:graduación", "length:largo", "occasion:fiesta"]);
    expect(tasks[tasks.length - 1]).toEqual({ kind: "questions" });
    expect(new Set(values).size).toBe(values.length);
  });
  it("a small budget still touches every facet before going deeper", () => {
    const tasks = planExpansion(facets, 10); // 6 calls: 5 values + questions
    const touched = new Set(tasks.flatMap((t) => (t.kind === "value" ? [t.facet] : [])));
    expect(touched.size).toBe(3);
    expect(tasks.length).toBe(6);
  });
});

describe("chunking", () => {
  it("chunk and ranges cover everything exactly once", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(ranges(5, 2)).toEqual([{ from: 0, to: 2 }, { from: 2, to: 4 }, { from: 4, to: 5 }]);
    expect(ranges(0, 2)).toEqual([]);
  });
});

describe("coordinator decision", () => {
  const c = (queued: number, running: number, dead = 0) => ({ queued, running, succeeded: 3, dead });
  it("waits while jobs are live, goes when all are done, fails on a dead job or a timeout", () => {
    expect(decideAdvance("s2", c(1, 0), 0)).toEqual({ action: "wait" });
    expect(decideAdvance("s2", c(0, 2), 5)).toEqual({ action: "wait" });
    expect(decideAdvance("s2", c(0, 0), 5)).toEqual({ action: "go" });
    expect(decideAdvance("s2", c(0, 0, 1), 5).action).toBe("fail");
    expect(decideAdvance("s2", c(1, 0), LIMITS.advanceMaxPolls).action).toBe("fail");
  });
  it("a dead job wins over live ones (do not keep spending on a doomed run)", () => {
    expect(decideAdvance("embed", c(3, 1, 1), 1).action).toBe("fail");
  });
});

describe("judge slots and model guard", () => {
  it("slots grow with pending pairs and are capped", () => {
    expect(judgeSlots(1)).toBe(1);
    expect(judgeSlots(24)).toBe(1);
    expect(judgeSlots(25)).toBe(2);
    expect(judgeSlots(1500)).toBe(60);
  });
  it("one embedding model per run", () => {
    expect(embeddingModelCheck(["a", "a", null])).toEqual({ ok: true, model: "a" });
    expect(embeddingModelCheck([])).toEqual({ ok: true, model: null });
    expect(embeddingModelCheck(["a", "b"]).ok).toBe(false);
  });
});

describe("thresholds", () => {
  it("uses valid run params, falls back to the placeholders otherwise", () => {
    expect(thresholdsFor({ thresholds: { high: 0.9, low: 0.7 } })).toEqual({ high: 0.9, low: 0.7 });
    expect(thresholdsFor({ thresholds: { high: 0.5, low: 0.7 } })).toEqual(REAL_EMBEDDER_THRESHOLDS);
    expect(thresholdsFor(null)).toEqual(REAL_EMBEDDER_THRESHOLDS);
  });
});
