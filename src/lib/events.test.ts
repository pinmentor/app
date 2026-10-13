import { describe, expect, it } from "vitest";
import { EVENT_NAMES, trackInputSchema } from "./events";

const WS = "11111111-1111-4111-8111-111111111111";

describe("trackInputSchema", () => {
  it("accepts a minimal event and defaults props to {}", () => {
    const r = trackInputSchema.parse({ name: "map_created", workspaceId: WS });
    expect(r.props).toEqual({});
  });

  it("accepts ids and counts in props", () => {
    expect(trackInputSchema.safeParse({ name: "batch_started", workspaceId: WS, props: { batch_id: WS, items: 12 } }).success).toBe(true);
  });

  it("rejects unknown event names", () => {
    expect(trackInputSchema.safeParse({ name: "something_else", workspaceId: WS }).success).toBe(false);
  });

  it("rejects a non-uuid workspace", () => {
    expect(trackInputSchema.safeParse({ name: "signup", workspaceId: "nope" }).success).toBe(false);
  });

  it("rejects props that contain an email address (no PII in analytics)", () => {
    expect(trackInputSchema.safeParse({ name: "signup", workspaceId: WS, props: { who: "a@example.com" } }).success).toBe(false);
  });

  it("rejects oversized props", () => {
    expect(trackInputSchema.safeParse({ name: "signup", workspaceId: WS, props: { blob: "x".repeat(5000) } }).success).toBe(false);
  });

  it("covers every PLAN §10.3 event name", () => {
    expect(EVENT_NAMES).toContain("trial_exhausted");
    expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length);
  });
});
