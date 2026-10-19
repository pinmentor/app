import { describe, expect, it } from "vitest";
import { clusterSilos, foldEdges, pickPillar, siloNameOrFallback, siloNameResponseSchema, type Edge } from "./silo";

/** two tight groups of `size` items (0..size-1 and size..2size-1), weak links between them */
function twoGroups(size: number): Edge[] {
  const e: Edge[] = [];
  for (let g = 0; g < 2; g++)
    for (let i = 0; i < size; i++) for (let j = i + 1; j < size; j++) e.push({ a: g * size + i, b: g * size + j, sim: 0.8 });
  e.push({ a: 0, b: size, sim: 0.55 });
  return e;
}
const flat = (gs: number[][]) => gs.flat().sort((x, y) => x - y);

describe("clusterSilos", () => {
  it("separates two tight groups", () => {
    const gs = clusterSilos(40, twoGroups(20), { minSize: 15, maxSize: 25, minSim: 0.5 });
    expect(gs.length).toBe(2);
    expect(gs.map((g) => g.length)).toEqual([20, 20]);
    expect(gs[0]!.every((i) => i < 20)).toBe(true);
  });
  it("never exceeds the size cap and covers every item exactly once", () => {
    const gs = clusterSilos(60, twoGroups(30), { minSize: 15, maxSize: 20, minSim: 0.5 });
    expect(gs.every((g) => g.length <= 20)).toBe(true);
    expect(flat(gs)).toEqual(Array.from({ length: 60 }, (_, i) => i));
  });
  it("items without any edge are not lost: they join groups that still have room", () => {
    const gs = clusterSilos(25, twoGroups(10), { minSize: 10, maxSize: 40, minSim: 0.5 });
    expect(flat(gs)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });
  it("a small map becomes one silo", () => {
    const gs = clusterSilos(12, [{ a: 0, b: 1, sim: 0.9 }], { minSize: 15, maxSize: 40, minSim: 0.5 });
    expect(gs.length).toBe(1);
    expect(gs[0]!.length).toBe(12);
  });
  it("is deterministic and handles empty input", () => {
    expect(clusterSilos(0, [])).toEqual([]);
    expect(clusterSilos(40, twoGroups(20))).toEqual(clusterSilos(40, twoGroups(20)));
  });
});

describe("edges and pillar", () => {
  it("folds both directions, keeps the max, drops self and out-of-range edges", () => {
    const f = foldEdges(3, [{ a: 0, b: 1, sim: 0.6 }, { a: 1, b: 0, sim: 0.7 }, { a: 2, b: 2, sim: 1 }, { a: 0, b: 9, sim: 1 }]);
    expect(f).toEqual([{ a: 0, b: 1, sim: 0.7 }]);
  });
  it("the pillar is the most central item; ties go to the shorter keyword", () => {
    const raw = ["peinados", "peinados faciles para boda", "peinados con trenza"];
    const edges: Edge[] = [{ a: 0, b: 1, sim: 0.8 }, { a: 0, b: 2, sim: 0.8 }, { a: 1, b: 2, sim: 0.5 }];
    expect(pickPillar([0, 1, 2], edges, (i) => raw[i]!)).toBe(0);
    expect(pickPillar([1, 2], [{ a: 1, b: 2, sim: 0.5 }], (i) => raw[i]!)).toBe(2);
  });
});

describe("silo names", () => {
  it("falls back to the capitalised pillar when the model gave no name", () => {
    expect(siloNameOrFallback("", "peinados con trenzas")).toBe("Peinados con trenzas");
    expect(siloNameOrFallback("Trenzas", "x")).toBe("Trenzas");
  });
  it("is tolerant about missing glosses", () => {
    expect(siloNameResponseSchema.parse([{ i: 0, name: " Trenzas " }])).toEqual([{ i: 0, name: "Trenzas", gloss_en: "", gloss_bn: "" }]);
  });
});
