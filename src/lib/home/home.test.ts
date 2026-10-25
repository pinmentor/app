import { describe, expect, it } from "vitest";
import { userPath, type PathInput } from "./user-path";
import { adminAttention, adminSetup, type AdminInput } from "./admin-overview";

const u = (o: Partial<PathInput> = {}): PathInput => ({ sitesConnected: 0, mapsReady: 0, latestMapId: null, itemsApproved: 0, articlesReady: 0, draftsSent: 0, unsent: null, ...o });

describe("userPath", () => {
  it("a new user starts at step 1 and every step has a destination", () => {
    const p = userPath(u());
    expect(p.now).toBe(0);
    expect(p.steps.length).toBe(5);
    expect(p.steps.every((s) => s.href.startsWith("/"))).toBe(true);
  });
  it("the first unfinished step is now, even if a later one is already done", () => {
    expect(userPath(u({ sitesConnected: 1 })).now).toBe(1);
    expect(userPath(u({ mapsReady: 1, latestMapId: "m", articlesReady: 2 })).now).toBe(0);
    expect(userPath(u({ sitesConnected: 1, mapsReady: 1, latestMapId: "m", itemsApproved: 3 })).now).toBe(3);
  });
  it("links go to the latest map and to an unsent article", () => {
    const p = userPath(u({ sitesConnected: 1, mapsReady: 1, latestMapId: "m1", itemsApproved: 1, articlesReady: 1, unsent: { runId: "m1", articleId: "a9" } }));
    expect(p.now).toBe(4);
    expect(p.steps[2]?.href).toBe("/maps/m1");
    expect(p.steps[4]?.href).toBe("/maps/m1/articles/a9");
  });
  it("all done gives now = -1 and plural-aware text", () => {
    const p = userPath(u({ sitesConnected: 1, mapsReady: 2, latestMapId: "m", itemsApproved: 1, articlesReady: 5, draftsSent: 1 }));
    expect(p.now).toBe(-1);
    expect(p.steps.map((s) => s.doneText).join("|")).toBe("1 site connected|2 maps ready|1 idea approved|5 articles ready|1 draft sent");
  });
});

const a = (o: Partial<AdminInput> = {}): AdminInput => ({ encryptionKey: "ok", keysSet: 2, articleWriteRate: 0, deadJobs7d: 0, failedArticles7d: 0, stuckQueued: 0, mapsTotal: 1, ...o });

describe("admin overview", () => {
  it("nothing to report when healthy", () => {
    expect(adminAttention(a()).length).toBe(0);
    expect(adminSetup(a()).now).toBe(-1);
  });
  it("urgent problems come first, in a fixed order", () => {
    const ids = adminAttention(a({ encryptionKey: "missing", keysSet: 0, articleWriteRate: null, deadJobs7d: 2, failedArticles7d: 1, stuckQueued: 3 })).map((x) => x.id);
    expect(ids.join(",")).toBe("enc,keys,rate,dead,art,queue");
  });
  it("a price of 0 is a price (not 'unset')", () => {
    expect(adminAttention(a({ articleWriteRate: 0 })).some((x) => x.id === "rate")).toBe(false);
    expect(adminSetup(a({ articleWriteRate: null })).now).toBe(1);
  });
  it("setup waits for a usable master key, not just a stored key", () => {
    expect(adminSetup(a({ encryptionKey: "invalid" })).now).toBe(0);
    expect(adminSetup(a({ mapsTotal: 0 })).now).toBe(2);
  });
  it("wording is singular/plural correct", () => {
    expect(adminAttention(a({ deadJobs7d: 1 }))[0]?.text).toBe("1 job failed for good in the last 7 days.");
    expect(adminAttention(a({ stuckQueued: 1 }))[0]?.text.startsWith("1 job is waiting")).toBe(true);
  });
});
