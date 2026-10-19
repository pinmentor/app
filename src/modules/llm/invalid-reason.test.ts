import { describe, expect, it } from "vitest";
import { invalidReason } from "./json";

describe("invalidReason", () => {
  it("names why an answer was unusable", () => {
    expect(invalidReason('[{"i":0', 3000, 3000, false)).toBe("invalid_output:truncated");
    expect(invalidReason("  ", 5, 3000, false)).toBe("invalid_output:empty");
    expect(invalidReason("sorry, I cannot", 20, 3000, false)).toBe("invalid_output:not_json|sorry, I cannot");
    expect(invalidReason('{"a":1}', 20, 3000, true)).toBe("invalid_output:schema|{\"a\":1}");
  });
});
