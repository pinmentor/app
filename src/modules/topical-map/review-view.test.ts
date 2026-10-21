import { describe, expect, it } from "vitest";
import { glossLine, parseEditForm, parseGlossMode, parseReviewForm, statusCounts, statusForIntent } from "./review-view";

const RUN = "11111111-1111-4111-8111-111111111111";
const I1 = "22222222-2222-4222-8222-222222222222";
const form = (o: Record<string, string | string[]>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
};

describe("translation display", () => {
  const g = { keyword: { en: "easy hairstyles", bn: "সহজ চুলের স্টাইল" } };
  it("off shows nothing; one language or both on request", () => {
    expect(glossLine(g, "keyword", "off")).toBe("");
    expect(glossLine(g, "keyword", "bn")).toBe("সহজ চুলের স্টাইল");
    expect(glossLine(g, "keyword", "en")).toBe("easy hairstyles");
    expect(glossLine(g, "keyword", "both")).toBe("easy hairstyles · সহজ চুলের স্টাইল");
    expect(glossLine({}, "title", "both")).toBe("");
  });
  it("an unknown mode falls back to off", () => {
    expect(parseGlossMode("both")).toBe("both");
    expect(parseGlossMode("fr")).toBe("off");
    expect(parseGlossMode(undefined)).toBe("off");
  });
});

describe("review form", () => {
  it("needs a run, a known intent and (except approve_clean) at least one item id", () => {
    expect(parseReviewForm(form({ run: RUN, intent: "approve", id: [I1] }))?.ids).toEqual([I1]);
    expect(parseReviewForm(form({ run: RUN, intent: "approve" }))).toBeNull();
    expect(parseReviewForm(form({ run: RUN, intent: "approve_clean" }))?.ids).toEqual([]);
    expect(parseReviewForm(form({ run: RUN, intent: "publish", id: [I1] }))).toBeNull();
    expect(parseReviewForm(form({ run: "nope", intent: "reject", id: [I1] }))).toBeNull();
    expect(parseReviewForm(form({ run: RUN, intent: "reject", id: ["not-a-uuid"] }))).toBeNull();
  });
  it("a bad gloss value becomes off, intents map to statuses", () => {
    expect(parseReviewForm(form({ run: RUN, intent: "proposed", id: [I1], gloss: "xx" }))?.gloss).toBe("off");
    expect([statusForIntent("approve"), statusForIntent("reject"), statusForIntent("proposed")]).toEqual(["approved", "rejected", "proposed"]);
  });
  it("counts statuses", () => {
    const c = statusCounts(["proposed", "approved", "approved", "rejected", "in_batch", "draft", "weird"]);
    expect(c).toMatchObject({ proposed: 1, approved: 2, rejected: 1, in_batch: 1, writing: 0, done: 0 });
    expect(Object.keys(c)).toHaveLength(12);
    expect((c as Record<string, number>).draft).toBe(undefined);
  });
  it("the old intent name draft is no longer accepted", () => {
    expect(parseReviewForm(form({ run: RUN, intent: "draft", id: [I1] }))).toBeNull();
  });
});

describe("edit form", () => {
  const I2 = "33333333-3333-4333-8333-333333333333";
  const S1 = "44444444-4444-4444-8444-444444444444";
  it("merge needs exactly two different items and keeps the first", () => {
    expect(parseEditForm(form({ run: RUN, intent: "merge", id: [I1, I2] }))).toMatchObject({ intent: "merge", ids: [I1, I2] });
    expect(parseEditForm(form({ run: RUN, intent: "merge", id: [I1] }))).toBeNull();
    expect(parseEditForm(form({ run: RUN, intent: "merge", id: [I1, I1] }))).toBeNull();
    expect(parseEditForm(form({ run: RUN, intent: "merge", id: [I1, I2, S1] }))).toBeNull();
  });
  it("move needs items and a silo id", () => {
    expect(parseEditForm(form({ run: RUN, intent: "move", id: [I1, I2], silo: S1 }))).toMatchObject({ intent: "move", silo: S1 });
    expect(parseEditForm(form({ run: RUN, intent: "move", id: [I1] }))).toBeNull();
    expect(parseEditForm(form({ run: RUN, intent: "move", silo: S1 }))).toBeNull();
    expect(parseEditForm(form({ run: RUN, intent: "move", id: [I1], silo: "x" }))).toBeNull();
  });
  it("split reads '<item>|<variant>' and keeps a | inside the variant", () => {
    expect(parseEditForm(form({ run: RUN, intent: "split", variant: `${I1}|peinados  fáciles` }))).toMatchObject({ item: I1, variant: "peinados  fáciles" });
    expect(parseEditForm(form({ run: RUN, intent: "split", variant: `${I1}|a|b` }))).toMatchObject({ variant: "a|b" });
    expect(parseEditForm(form({ run: RUN, intent: "split", variant: "no-separator" }))).toBeNull();
    expect(parseEditForm(form({ run: RUN, intent: "split", variant: `${I1}|  ` }))).toBeNull();
    expect(parseEditForm(form({ run: RUN, intent: "approve", id: [I1] }))).toBeNull();
  });
});
