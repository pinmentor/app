import { describe, expect, it } from "vitest";
import { classifyResponseSchema } from "./classify";
import { judgeResponseSchema } from "./schemas";
import { siloNameResponseSchema } from "./silo";
import { titleResponseSchema } from "./titles";

describe("tolerant LLM list answers", () => {
  it("judge: cleans verdict labels, trims reasons, drops only the broken items", () => {
    const r = judgeResponseSchema.parse([
      { i: 0, verdict: "Same", reason: "x".repeat(500) },
      { i: "1", verdict: " Parent-Child ", reason: null },
      { i: 2, verdict: "maybe", reason: "?" },
      "junk",
      { i: 3, verdict: "different" },
    ]);
    expect(r.map((x) => `${x.i}:${x.verdict}`)).toEqual(["0:same", "1:parent_child", "3:different"]);
    expect(r[0]!.reason.length).toBe(300);
    expect(r[1]!.reason).toBe("");
  });
  it("accepts an object that wraps the list, rejects an answer with nothing usable", () => {
    expect(judgeResponseSchema.parse({ results: [{ i: 0, verdict: "same", reason: "r" }] }).length).toBe(1);
    expect(judgeResponseSchema.safeParse([{ i: 0, verdict: "nope" }]).success).toBe(false);
    expect(judgeResponseSchema.safeParse("text").success).toBe(false);
    expect(judgeResponseSchema.safeParse({ a: 1, b: 2 }).success).toBe(false);
  });
  it("classify: string booleans and missing fields are fine, a broken item is dropped", () => {
    const r = classifyResponseSchema.parse([{ i: 0, intent: "informational", mixed: "true" }, { i: 1 }, { nope: true }]);
    expect(r.length).toBe(2);
    expect(r[0]!.mixed).toBe(true);
    expect(r[1]!.intent).toBe("informational");
  });
  it("silo names and titles survive odd items", () => {
    expect(siloNameResponseSchema.parse([{ i: 0, name: 5 }, { i: 1, name: "Trenzas", gloss_en: "braids" }]).map((x) => x.name)).toEqual(["", "Trenzas"]);
    expect(titleResponseSchema.parse([{ i: 0, titles: ["a title here", 7, ""] }, { i: 1 }]).length).toBe(1);
  });
});
