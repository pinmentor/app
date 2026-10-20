import { describe, expect, it } from "vitest";
import { glossLine, parseGlossMode, parseReviewForm, statusCounts, statusForIntent } from "./review-view";

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
    expect(parseReviewForm(form({ run: RUN, intent: "draft", id: [I1], gloss: "xx" }))?.gloss).toBe("off");
    expect([statusForIntent("approve"), statusForIntent("reject"), statusForIntent("draft")]).toEqual(["approved", "rejected", "draft"]);
  });
  it("counts statuses", () => {
    expect(statusCounts(["draft", "approved", "approved", "rejected", "weird"])).toEqual({ draft: 1, approved: 2, rejected: 1 });
  });
});
