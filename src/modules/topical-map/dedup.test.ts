import { describe, expect, it } from "vitest";
import { decidePair, type Thresholds } from "./compare";
import { dedupe, DEFAULT_THRESHOLDS } from "./dedup";
import { cosine, lexicalEmbedder } from "./embed";
import { conservativeJudge, llmIntentJudge } from "./judge";
import { normalize } from "./normalize";

const emb = lexicalEmbedder();
const run = (raws: string[], judge = conservativeJudge) =>
  dedupe(raws.map((raw) => ({ raw, source: "test" })), { embedder: emb, judge, thresholds: DEFAULT_THRESHOLDS });

describe("dedupe", () => {
  it("merges synonyms and word-order variants into one primary with variants", async () => {
    const r = await run(["peinados fáciles", "peinados sencillos", "peinados simples", "peinados elegantes"]);
    expect(r.groups).toHaveLength(2);
    const easy = r.groups.find((g) => g.variants.length === 2)!;
    expect(easy.primary.raw).toBe("peinados fáciles"); // shortest, then alphabetical
    expect(easy.variants.map((v) => v.raw).sort()).toEqual(["peinados sencillos", "peinados simples"]);
  });

  it("never merges modifier-exclusive keywords, whatever the cosine", async () => {
    const r = await run(["peinados para niñas", "peinados para niños", "peinados para mujeres"]);
    expect(r.groups).toHaveLength(3);
  });

  it("keeps a narrower keyword as its own group and records parent/child", async () => {
    const r = await run(["peinados fáciles", "peinados fáciles para niñas"]);
    expect(r.groups).toHaveLength(2);
    expect(r.parentChild).toEqual([{ parent: "peinados fáciles", child: "peinados fáciles para niñas" }]);
  });

  it("picks the strongest demand signal as primary", async () => {
    const r = await dedupe(
      [
        { raw: "peinados sencillos", source: "t", demandTier: 5 },
        { raw: "peinados fáciles", source: "t", demandTier: 2 },
      ],
      { embedder: emb, judge: conservativeJudge },
    );
    expect(r.groups[0]!.primary.raw).toBe("peinados sencillos");
  });

  it("is deterministic regardless of input order", async () => {
    const list = ["peinados fáciles", "peinados sencillos", "trenzas para niñas", "peinados de trenzas para niñas"];
    const a = await run(list);
    const b = await run([...list].reverse());
    const sig = (r: typeof a) => r.groups.map((g) => `${g.primary.raw}|${g.variants.map((v) => v.raw).sort().join(",")}`).sort();
    expect(sig(a)).toEqual(sig(b));
  });

  it("sends borderline pairs to the judge and honours its answer", async () => {
    const judge = llmIntentJudge(async () => [{ i: 0, verdict: "same", reason: "synonyms" }]);
    const t: Thresholds = { high: 0.99, low: 0.1 }; // force borderline
    const r = await dedupe([{ raw: "cabello radiante", source: "t" }, { raw: "pelo brillante", source: "t" }], {
      embedder: emb,
      judge,
      thresholds: t,
    });
    expect(r.stats.judged).toBe(1);
    expect(r.groups).toHaveLength(1);
  });
});

describe("llmIntentJudge", () => {
  it("keeps pairs separate when the model returns garbage or skips a pair", async () => {
    const garbage = llmIntentJudge(async () => "not json");
    expect((await garbage.judge([{ a: "x", b: "y" }]))[0]!.verdict).toBe("related");
    const partial = llmIntentJudge(async () => [{ i: 1, verdict: "same", reason: "r" }]);
    const out = await partial.judge([{ a: "a", b: "b" }, { a: "c", b: "d" }]);
    expect(out.map((o) => o.verdict)).toEqual(["related", "same"]);
  });
  it("batches at 30 pairs per call", async () => {
    let calls = 0;
    const judge = llmIntentJudge(async ({ prompt }) => {
      calls++;
      return prompt.split("\n").map((_, i) => ({ i, verdict: "different", reason: "r" }));
    });
    const pairs = Array.from({ length: 65 }, (_, i) => ({ a: `a${i}`, b: `b${i}` }));
    expect(await judge.judge(pairs)).toHaveLength(65);
    expect(calls).toBe(3);
  });
});

describe("decidePair", () => {
  const d = (a: string, b: string) => {
    return decidePair(normalize(a), normalize(b), 0.7, DEFAULT_THRESHOLDS);
  };
  it("exact key first, then conflict veto, then parent/child", () => {
    expect(d("peinados fáciles", "fáciles peinados").by).toBe("exact");
    expect(d("peinados para niñas", "peinados para niños").verdict).toBe("different");
    expect(d("peinados", "peinados para mujer").verdict).toBe("parent_child");
  });
  it("cosine helper is sane", () => expect(cosine([1, 0], [1, 0])).toBe(1));
});
