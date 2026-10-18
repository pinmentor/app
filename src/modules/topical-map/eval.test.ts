import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "./dedup";
import { lexicalEmbedder } from "./embed";
import { parseGold, predictAll, recommendThresholds, score, sweepThresholds } from "./eval";
import { conservativeJudge } from "./judge";

const root = join(__dirname, "../../..");
const gold = parseGold(readFileSync(join(root, "eval/golden/es-peinados.jsonl"), "utf8"));
const floors = JSON.parse(readFileSync(join(root, "eval/floors.json"), "utf8")) as { precision: number; recall: number };

describe("gold set", () => {
  it("is well formed, balanced and has unique ids", () => {
    expect(new Set(gold.map((g) => g.id)).size).toBe(gold.length);
    expect(gold.length).toBeGreaterThanOrEqual(120);
    for (const label of ["same", "parent_child", "related", "different"] as const) {
      expect(gold.filter((g) => g.label === label).length).toBeGreaterThanOrEqual(20);
    }
    expect(gold.some((g) => g.split === "dev")).toBe(true);
    expect(gold.some((g) => g.split === "test")).toBe(true);
  });
  it("has no pair listed twice (either order)", () => {
    const keys = gold.map((g) => [g.a, g.b].sort().join("\u0000"));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("dedup regression (offline baseline, test split)", () => {
  it("stays above the floors in eval/floors.json", async () => {
    const preds = await predictAll(gold, { embedder: lexicalEmbedder(), judge: conservativeJudge, thresholds: DEFAULT_THRESHOLDS });
    const m = score(preds.filter((p) => p.pair.split === "test"));
    expect(m.precision).toBeGreaterThanOrEqual(floors.precision);
    expect(m.recall).toBeGreaterThanOrEqual(floors.recall);
  });
});

describe("threshold sweep", () => {
  it("scores a grid and recommends the best recall that meets the precision floor", async () => {
    const dev = gold.filter((g) => g.split === "dev");
    const rows = await sweepThresholds(dev, { embedder: lexicalEmbedder("es-MX"), judge: conservativeJudge, highs: [0.8, 0.88], lows: [0.5, 0.6] });
    expect(rows.length).toBe(4);
    const best = recommendThresholds(rows, 0.95);
    expect(best).not.toBeNull();
    expect(best!.precision).toBeGreaterThanOrEqual(0.95);
    expect(recommendThresholds(rows, 1.01)).toBeNull();
  });
  it("breaks ties toward fewer false merges, then the more conservative thresholds", () => {
    const r = (high: number, low: number, recall: number, fp: number) => ({ high, low, precision: 0.97, recall, fp, fn: 1 });
    expect(recommendThresholds([r(0.88, 0.6, 0.9, 2), r(0.92, 0.6, 0.9, 1), r(0.9, 0.6, 0.9, 1)], 0.95)).toMatchObject({ high: 0.92 });
  });
});
