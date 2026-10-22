import { describe, expect, it } from "vitest";
import { nextStep, type NextInput } from "./next-step";

const base: NextInput = { finished: true, items: [], batches: [], articles: [], suggested: 0 };
const it_ = (status: string, batch_id: string | null = null) => ({ status, batch_id });

describe("nextStep", () => {
  it("map not finished", () => {
    const n = nextStep({ ...base, finished: false }, "r");
    expect(n.step).toBe(0);
    expect(n.action.kind).toBe("none");
  });
  it("proposed items only -> step 1 Review", () => {
    const n = nextStep({ ...base, items: [it_("proposed"), it_("proposed")] }, "r");
    expect(n.step).toBe(1);
    expect(n.action).toEqual({ kind: "link", label: "Go to Review", href: "/maps/r" });
  });
  it("approved free items -> step 2, create suggested batches", () => {
    const n = nextStep({ ...base, items: [it_("approved"), it_("proposed")], suggested: 2 }, "r");
    expect(n.step).toBe(2);
    expect(n.action.kind).toBe("make_batches");
    expect(n.title).toContain("1 approved article ");
  });
  it("approved but nothing suggested -> link to batches", () => {
    expect(nextStep({ ...base, items: [it_("approved")], suggested: 0 }, "r").action.kind).toBe("link");
  });
  it("a planned batch wins over approved items -> step 3, write it", () => {
    const n = nextStep({ ...base, items: [it_("in_batch", "b1"), it_("in_batch", "b1"), it_("approved")], batches: [{ id: "b1", name: "Batch 1", status: "planned" }], suggested: 1 }, "r");
    expect(n.step).toBe(3);
    expect(n.action).toEqual({ kind: "write_batch", label: "Write this batch", batchId: "b1" });
    expect(n.title).toContain("2 articles");
  });
  it("running -> progress, refresh", () => {
    const n = nextStep({ ...base, batches: [{ id: "b1", name: "B", status: "running" }], articles: [{ id: "a1", batch_id: "b1", status: "ready" }, { id: "a2", batch_id: "b1", status: "writing" }] }, "r");
    expect(n.step).toBe(3);
    expect(n.title).toBe("Writing: 1 of 2 articles done");
  });
  it("written -> step 4; red and yellow first", () => {
    const n = nextStep({ ...base, batches: [{ id: "b1", name: "B", status: "completed" }], articles: [
      { id: "g", batch_id: "b1", status: "ready", qa: { verdict: "pass" } },
      { id: "y", batch_id: "b1", status: "ready", qa: { verdict: "flag" } },
      { id: "r", batch_id: "b1", status: "ready", qa: { verdict: "fail" } },
    ] }, "m");
    expect(n.step).toBe(4);
    expect(n.title).toBe("2 of 3 written articles need a look");
    expect(n.action).toEqual({ kind: "link", label: "Open the first one", href: "/maps/m/articles/r" });
  });
  it("all green -> open an article", () => {
    const n = nextStep({ ...base, batches: [{ id: "b1", name: "B", status: "completed" }], articles: [{ id: "g", batch_id: "b1", status: "ready", qa: { verdict: "pass" } }] }, "m");
    expect(n.title).toContain("1 article is ready and passed");
  });
  it("nothing to do", () => {
    expect(nextStep({ ...base, items: [it_("rejected")] }, "r").step).toBe(0);
  });
});
