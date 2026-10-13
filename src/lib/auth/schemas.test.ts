import { describe, expect, it } from "vitest";
import { callbackOtpTypeSchema, emailSchema, loginInputSchema, safeNextPath } from "./schemas";

describe("emailSchema", () => {
  it("trims and lowercases", () => {
    expect(emailSchema.parse("  Foo@Example.COM ")).toBe("foo@example.com");
  });
  it.each(["", "foo", "foo@", "@example.com", "a b@example.com"])("rejects %j", (v) => {
    expect(emailSchema.safeParse(v).success).toBe(false);
  });
  it("rejects absurdly long input", () => {
    expect(emailSchema.safeParse(`${"a".repeat(250)}@example.com`).success).toBe(false);
  });
});

describe("loginInputSchema", () => {
  it("requires a captcha token", () => {
    expect(loginInputSchema.safeParse({ email: "a@example.com", captchaToken: "" }).success).toBe(false);
    expect(loginInputSchema.safeParse({ email: "a@example.com" }).success).toBe(false);
  });
  it("accepts a valid pair", () => {
    expect(loginInputSchema.parse({ email: "A@example.com", captchaToken: "tok" })).toEqual({
      email: "a@example.com",
      captchaToken: "tok",
    });
  });
});

describe("callbackOtpTypeSchema", () => {
  it("accepts magic-link types only", () => {
    expect(callbackOtpTypeSchema.safeParse("email").success).toBe(true);
    expect(callbackOtpTypeSchema.safeParse("magiclink").success).toBe(true);
    expect(callbackOtpTypeSchema.safeParse("recovery").success).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("keeps same-site paths", () => {
    expect(safeNextPath("/dashboard")).toBe("/dashboard");
    expect(safeNextPath("/dashboard?tab=a")).toBe("/dashboard?tab=a");
  });
  it.each([null, undefined, "", "dashboard", "https://evil.com", "//evil.com", "/\\evil.com", "/a\nb"])(
    "falls back for %j",
    (v) => {
      expect(safeNextPath(v)).toBe("/dashboard");
    },
  );
  it("uses a custom fallback", () => {
    expect(safeNextPath("https://evil.com", "/")).toBe("/");
  });
});
