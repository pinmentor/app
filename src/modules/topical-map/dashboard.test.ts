import { describe, expect, it } from "vitest";
import { counters, groupOf, siloProgress, STATUS_GROUPS } from "./dashboard";
import { ITEM_STATUSES } from "./review-view";

describe("status groups (PLAN §4.1)", () => {
  it("every status of the vocabulary belongs to exactly one group", () => {
    for (const s of ITEM_STATUSES) expect(groupOf(s)).not.toBeNull();
    const all = Object.values(STATUS_GROUPS).flat();
    expect(all).toHaveLength(ITEM_STATUSES.length);
    expect(new Set(all).size).toBe(all.length);
  });
  it("views: scheduled and published leave Remaining", () => {
    expect([groupOf("proposed"), groupOf("approved"), groupOf("in_batch")]).toEqual(["remaining", "remaining", "remaining"]);
    expect([groupOf("writing"), groupOf("draft_ready"), groupOf("in_review")]).toEqual(["inProgress", "inProgress", "inProgress"]);
    expect([groupOf("scheduled"), groupOf("published"), groupOf("pins_pending"), groupOf("done")]).toEqual(["completed", "completed", "completed", "completed"]);
    expect([groupOf("rejected"), groupOf("already_exists")]).toEqual(["setAside", "setAside"]);
    expect(groupOf("draft")).toBeNull();
  });
});

describe("counters", () => {
  it("counts the groups; an unknown status is only in total", () => {
    expect(counters(["proposed", "approved", "in_batch", "writing", "done", "published", "rejected", "mystery"])).toEqual({ remaining: 3, inProgress: 1, completed: 2, setAside: 1, total: 8 });
    expect(counters([])).toEqual({ remaining: 0, inProgress: 0, completed: 0, setAside: 0, total: 0 });
  });
});

describe("silo progress", () => {
  it("completed of the items that are not set aside", () => {
    expect(siloProgress(["done", "published", "approved", "proposed", "rejected"])).toEqual({ done: 2, of: 4, pct: 50 });
    expect(siloProgress(["rejected"])).toEqual({ done: 0, of: 0, pct: 0 });
    expect(siloProgress(["done", "scheduled"])).toEqual({ done: 2, of: 2, pct: 100 });
  });
});
