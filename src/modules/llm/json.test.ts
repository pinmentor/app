import { describe, expect, it } from "vitest";
import { extractJson } from "./json";

describe("extractJson", () => {
  it("parses plain JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });
  it("unwraps ```json fences, with or without a language tag", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(extractJson("Here:\n```\n[1,2]\n```")).toEqual({ ok: true, value: [1, 2] });
  });
  it("finds JSON surrounded by chatter", () => {
    expect(extractJson('Sure! {"echo":"pong"} Hope that helps')).toEqual({ ok: true, value: { echo: "pong" } });
    expect(extractJson("result: [1, 2, 3] done")).toEqual({ ok: true, value: [1, 2, 3] });
  });
  it("reports failure instead of throwing", () => {
    expect(extractJson("not json at all")).toEqual({ ok: false });
    expect(extractJson("   ")).toEqual({ ok: false });
    expect(extractJson('{"a":')).toEqual({ ok: false });
  });
});
