import { describe, expect, it } from "vitest";
import { isCronAuthorized } from "./auth";

const secret = "s3cret-s3cret-s3cret";

describe("isCronAuthorized", () => {
  it("accepts the right bearer token", () => {
    expect(isCronAuthorized(`Bearer ${secret}`, secret)).toBe(true);
  });
  it("rejects a wrong token, a missing header, and a header without the Bearer scheme", () => {
    expect(isCronAuthorized("Bearer nope-nope-nope-nope", secret)).toBe(false);
    expect(isCronAuthorized(null, secret)).toBe(false);
    expect(isCronAuthorized(secret, secret)).toBe(false);
  });
  it("fails closed when the secret is unset, empty or too short", () => {
    expect(isCronAuthorized("Bearer x", undefined)).toBe(false);
    expect(isCronAuthorized("Bearer ", "")).toBe(false);
    expect(isCronAuthorized("Bearer short", "short")).toBe(false);
  });
});
