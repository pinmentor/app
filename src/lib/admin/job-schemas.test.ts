import { describe, expect, it } from "vitest";
import { jobActionSchema, stateFilterSchema, testJobSchema } from "./job-schemas";

const ID = "11111111-1111-4111-8111-111111111111";

describe("job admin schemas", () => {
  it("falls back to 'all' for an unknown state filter", () => {
    expect(stateFilterSchema.parse("dead")).toBe("dead");
    expect(stateFilterSchema.parse("nonsense")).toBe("all");
  });
  it("requires a uuid job id", () => {
    expect(jobActionSchema.safeParse({ jobId: ID }).success).toBe(true);
    expect(jobActionSchema.safeParse({ jobId: "x" }).success).toBe(false);
  });
  it("accepts only the four test modes and a real key", () => {
    expect(testJobSchema.safeParse({ mode: "llm", key: "abcdef12-key" }).success).toBe(true);
    expect(testJobSchema.safeParse({ mode: "rm -rf", key: "abcdef12-key" }).success).toBe(false);
    expect(testJobSchema.safeParse({ mode: "ok", key: "short" }).success).toBe(false);
  });
});
