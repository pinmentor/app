import { describe, expect, it } from "vitest";
import { balancedSizes, clampBatchSize, DEFAULT_BATCH_SIZE, nextBatchBySilo, parseAutoForm, parseBatchAction, parseManualForm, suggestBatches, type BatchableItem } from "./batching";

const RUN = "11111111-1111-4111-8111-111111111111";
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const form = (o: Record<string, string | string[]>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
};
const item = (n: number, siloId: string | null, priority: number, isPillar = false): BatchableItem => ({ id: `i${n}`, siloId, priority, position: n, isPillar });

describe("batch sizes", () => {
  it("balanced: no stub batch", () => {
    expect(balancedSizes(28, 15)).toEqual([14, 14]);
    expect(balancedSizes(31, 15)).toEqual([11, 10, 10]);
    expect(balancedSizes(15, 15)).toEqual([15]);
    expect(balancedSizes(3, 15)).toEqual([3]);
    expect(balancedSizes(0, 15)).toEqual([]);
    expect(balancedSizes(16, 15).reduce((a, b) => a + b, 0)).toBe(16);
  });
  it("size is clamped to 5..50 and defaults when garbage", () => {
    expect([clampBatchSize(1), clampBatchSize(99), clampBatchSize("20"), clampBatchSize("x"), clampBatchSize(null)]).toEqual([5, 50, 20, DEFAULT_BATCH_SIZE, DEFAULT_BATCH_SIZE]);
  });
});

describe("suggestBatches", () => {
  const silos = [
    { id: "sB", name: "Beta", position: 2 },
    { id: "sA", name: "Alpha", position: 1 },
  ];
  it("pillar first, then priority desc, ties by position; silos in silo order", () => {
    const items = [item(1, "sA", 10), item(2, "sA", 90), item(3, "sA", 50, true), item(4, "sA", 90), item(5, "sB", 1)];
    const r = suggestBatches(items, silos, 15);
    expect(r.map((b) => [b.name, b.itemIds])).toEqual([["Alpha", ["i3", "i2", "i4", "i1"]], ["Beta", ["i5"]]]);
    expect(r[0]!.hasPillar).toBe(true);
    expect(r[1]!.hasPillar).toBe(false);
  });
  it("a big silo is cut into balanced numbered batches and the pillar sits in the first", () => {
    const items = [...Array.from({ length: 28 }, (_, n) => item(n + 1, "sA", n)), item(99, "sA", 0, true)];
    const r = suggestBatches(items, silos, 15);
    expect(r.map((b) => [b.name, b.itemIds.length])).toEqual([["Alpha · 1/2", 15], ["Alpha · 2/2", 14]]);
    expect(r[0]!.itemIds[0]).toBe("i99");
    expect(r[0]!.hasPillar).toBe(true);
    expect(r[1]!.hasPillar).toBe(false);
    expect(new Set(r.flatMap((b) => b.itemIds)).size).toBe(29);
  });
  it("flags the first batch of a silo whose pillar is still waiting for approval", () => {
    const r = suggestBatches([item(1, "sA", 5), item(2, "sB", 5, true)], silos, 15, new Set(["sA"]));
    expect(r.find((b) => b.siloId === "sA")!.pillarPending).toBe(true);
    expect(r.find((b) => b.siloId === "sB")!.pillarPending).toBe(false);
  });
  it("items without a silo go into a 'No group' batch at the end; nothing offered = nothing suggested", () => {
    expect(suggestBatches([item(1, null, 1), item(2, "sA", 1)], silos, 15).map((b) => b.name)).toEqual(["Alpha", "No group"]);
    expect(suggestBatches([], silos, 15)).toEqual([]);
  });
  it("is stable: input order does not change the result", () => {
    const items = [item(1, "sA", 5), item(2, "sA", 5), item(3, "sA", 7)];
    expect(suggestBatches([...items].reverse(), silos, 15)[0]!.itemIds).toEqual(suggestBatches(items, silos, 15)[0]!.itemIds);
  });
  it("nextBatchBySilo returns the first batch of each silo", () => {
    const r = suggestBatches(Array.from({ length: 20 }, (_, n) => item(n + 1, "sA", n)), silos, 10);
    expect(nextBatchBySilo(r).get("sA")!.name).toBe("Alpha · 1/2");
    expect(nextBatchBySilo(r).has("sB")).toBe(false);
  });
});

describe("batch forms", () => {
  it("auto: all needs run + size; next also needs a silo", () => {
    expect(parseAutoForm(form({ run: RUN, size: "12", intent: "all" }))).toEqual({ run: RUN, size: 12, intent: "all" });
    expect(parseAutoForm(form({ run: RUN, size: "12", intent: "next" }))).toBeNull();
    expect(parseAutoForm(form({ run: RUN, size: "400", intent: "next", silo: U(1) }))).toMatchObject({ size: 50, silo: U(1) });
    expect(parseAutoForm(form({ run: "x", size: "12", intent: "all" }))).toBeNull();
    expect(parseAutoForm(form({ run: RUN, size: "12", intent: "weird" }))).toBeNull();
  });
  it("manual: a name and 1..100 distinct item ids", () => {
    expect(parseManualForm(form({ run: RUN, name: "  Summer  ", id: [U(1), U(2), U(1)] }))).toEqual({ run: RUN, name: "Summer", ids: [U(1), U(2)] });
    expect(parseManualForm(form({ run: RUN, name: "", id: [U(1)] }))).toBeNull();
    expect(parseManualForm(form({ run: RUN, name: "x" }))).toBeNull();
    expect(parseManualForm(form({ run: RUN, name: "x", id: ["nope"] }))).toBeNull();
    expect(parseManualForm(form({ run: RUN, name: "x", id: Array.from({ length: 101 }, (_, n) => U(n + 1)) }))).toBeNull();
  });
  it("cancel needs a batch; remove also needs ids", () => {
    expect(parseBatchAction(form({ run: RUN, batch: U(5), intent: "cancel" }))).toMatchObject({ intent: "cancel" });
    expect(parseBatchAction(form({ run: RUN, batch: U(5), intent: "remove" }))).toBeNull();
    expect(parseBatchAction(form({ run: RUN, batch: U(5), intent: "remove", id: [U(1)] }))).toMatchObject({ intent: "remove", ids: [U(1)] });
    expect(parseBatchAction(form({ run: RUN, batch: "no", intent: "cancel" }))).toBeNull();
  });
});
