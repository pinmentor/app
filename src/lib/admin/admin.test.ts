import { describe, expect, it } from "vitest";
import { canAdjustCredits, canEnqueueTestJobs, canManageJobs, isAdminRole } from "./roles";
import { creditAdjustSchema, userOverviewRowSchema } from "./schemas";

const WS = "11111111-1111-4111-8111-111111111111";
const base = { workspaceId: WS, delta: "25", reason: "goodwill grant", key: "abcdef12-key" };

describe("isAdminRole / canAdjustCredits", () => {
  it.each(["superadmin", "support", "finance", "analyst"])("%s may open /admin", (r) => {
    expect(isAdminRole(r)).toBe(true);
  });
  it.each(["user", "", "admin", "SUPERADMIN", null, undefined, 5])("%j may not", (r) => {
    expect(isAdminRole(r)).toBe(false);
  });
  it("only superadmin may adjust credits", () => {
    expect(canAdjustCredits("superadmin")).toBe(true);
    expect(canAdjustCredits("support")).toBe(false);
    expect(canAdjustCredits("finance")).toBe(false);
    expect(canAdjustCredits("analyst")).toBe(false);
  });
});

describe("creditAdjustSchema", () => {
  it("coerces the form string to an integer", () => {
    expect(creditAdjustSchema.parse(base).delta).toBe(25);
    expect(creditAdjustSchema.parse({ ...base, delta: "-10" }).delta).toBe(-10);
  });
  it.each(["0", "", "abc", "1.5", "100001", "-100001"])("rejects delta %j", (delta) => {
    expect(creditAdjustSchema.safeParse({ ...base, delta }).success).toBe(false);
  });
  it("requires a real reason and key", () => {
    expect(creditAdjustSchema.safeParse({ ...base, reason: "ab" }).success).toBe(false);
    expect(creditAdjustSchema.safeParse({ ...base, key: "short" }).success).toBe(false);
  });
  it("requires a uuid workspace", () => {
    expect(creditAdjustSchema.safeParse({ ...base, workspaceId: "x" }).success).toBe(false);
  });
});

describe("userOverviewRowSchema", () => {
  it("parses a row shaped like admin_user_overview()", () => {
    const row = {
      user_id: WS,
      email: "a@example.com",
      role: "user",
      suspended: false,
      created_at: "2026-10-13T05:00:00+00:00",
      last_sign_in_at: null,
      workspace_id: WS,
      workspace_name: "My workspace",
      credits_available: 30,
      credits_held: 0,
      total_count: 1,
    };
    expect(userOverviewRowSchema.safeParse(row).success).toBe(true);
  });
});

describe("job permissions", () => {
  it("superadmin and support may retry/cancel jobs", () => {
    expect(canManageJobs("superadmin")).toBe(true);
    expect(canManageJobs("support")).toBe(true);
    expect(canManageJobs("finance")).toBe(false);
    expect(canManageJobs("analyst")).toBe(false);
  });
  it("only superadmin may enqueue test jobs", () => {
    expect(canEnqueueTestJobs("superadmin")).toBe(true);
    expect(canEnqueueTestJobs("support")).toBe(false);
  });
});
