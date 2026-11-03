import { describe, expect, it } from "vitest";
import { parseKeywordInput, splitCsvLine, MAX_ITEMS } from "./csv";

const texts = (s: string) => parseKeywordInput(s, "es-MX").items.map((i) => i.text);

describe("parseKeywordInput", () => {
  it("reads one keyword per line, trims and skips blank lines", () => {
    expect(texts("  peinados faciles \n\n peinados con trenzas\r\n")).toEqual(["peinados faciles", "peinados con trenzas"]);
  });

  it("splits a lone line with commas, but not a list of lines", () => {
    expect(texts("peinados faciles, peinados rapidos, trenzas")).toEqual(["peinados faciles", "peinados rapidos", "trenzas"]);
    expect(texts("uno, dos\ntres")).toEqual(["uno, dos", "tres"]);
  });

  it("collapses the same keyword in another spelling (case, accents) and counts it", () => {
    const r = parseKeywordInput("Peinados fáciles\npeinados faciles\nPEINADOS FÁCILES", "es-MX");
    expect(r.items.map((i) => i.text)).toEqual(["Peinados fáciles"]);
    expect(r.duplicatesInFile).toBe(2);
  });

  it("rejects bad rows with their line number and a reason, and keeps the good ones", () => {
    const r = parseKeywordInput(["ok keyword", "https://example.com/x", "!!!", "x ".repeat(13).trim(), "a".repeat(201), "de la"].join("\n"), "es-MX");
    expect(r.items.map((i) => i.text)).toEqual(["ok keyword"]);
    expect(r.rejected.map((x) => [x.line, x.reason])).toEqual([[2, "looks_like_url"], [3, "no_letters"], [4, "too_many_words"], [5, "too_long"], [6, "only_filler_words"]]);
  });

  it("reads a CSV with a header: keyword column, tags column, quotes", () => {
    const csv = 'Clicks,Query,Tags\n10,"peinados, faciles",a|b\n5,trenzas,\n';
    const r = parseKeywordInput(csv, "es-MX");
    expect(r.hadHeader).toBe(true);
    expect(r.items.map((i) => i.text)).toEqual(["peinados, faciles", "trenzas"]);
    expect(r.items[0]!.tags).toEqual(["a", "b"]);
    expect(r.items[1]!.tags).toEqual([]);
  });

  it("reports the line number of a bad CSV row using the real file line", () => {
    const r = parseKeywordInput("keyword\nbuen peinado\nhttp://x.com\n", "es-MX");
    expect(r.rejected).toEqual([{ line: 3, text: "http://x.com", reason: "looks_like_url" }]);
  });

  it("takes the first cell of a spreadsheet row without a header, ignores a BOM", () => {
    expect(texts("﻿peinado uno\t100\npeinado dos;200")).toEqual(["peinado uno", "peinado dos"]);
  });

  it("stops at the maximum and says so", () => {
    const many = Array.from({ length: MAX_ITEMS + 5 }, (_, i) => `palabra${i} extra`).join("\n");
    const r = parseKeywordInput(many, "es-MX");
    expect(r.items).toHaveLength(MAX_ITEMS);
    expect(r.truncated).toBe(true);
  });

  it("empty input gives nothing", () => {
    const r = parseKeywordInput("  \n\n", "es-MX");
    expect(r.items).toEqual([]);
    expect(r.rejected).toEqual([]);
  });
});

describe("splitCsvLine", () => {
  it("handles quotes and doubled quotes", () => {
    expect(splitCsvLine('a,"b,c","d ""e"" f"', ",")).toEqual(["a", "b,c", 'd "e" f']);
  });
});
