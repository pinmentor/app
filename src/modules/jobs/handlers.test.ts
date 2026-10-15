import { describe, expect, it } from "vitest";
import { LlmError } from "@/modules/llm/errors";
import { describeFailure, handlers, JobError } from "./handlers";

const ctx = (payload: unknown) => ({ jobId: "j", workspaceId: "w", type: "test.noop", payload, attempt: 1 });

describe("test.noop handler", () => {
  const noop = handlers["test.noop"];

  it("succeeds in ok mode", async () => {
    expect(await noop?.(ctx({ mode: "ok" }))).toEqual({ ok: true });
  });
  it("fails retryably in fail mode and permanently in fail_permanent mode", async () => {
    await expect(noop?.(ctx({ mode: "fail" }))).rejects.toMatchObject({ retryable: true, code: "test_failure" });
    await expect(noop?.(ctx({ mode: "fail_permanent" }))).rejects.toMatchObject({ retryable: false });
  });
  it("rejects an invalid payload without retrying", async () => {
    await expect(noop?.(ctx({ mode: "bogus" }))).rejects.toMatchObject({ retryable: false, code: "invalid_payload" });
  });
});

describe("describeFailure", () => {
  it("keeps JobError details", () => {
    expect(describeFailure(new JobError("m", "c", { retryable: false, retryAfterSeconds: 5 }))).toEqual({
      message: "m", code: "c", retryable: false, retryAfterSeconds: 5,
    });
  });
  it("maps LlmError to its code and retryability", () => {
    expect(describeFailure(new LlmError("kill_switch", false))).toMatchObject({ code: "kill_switch", retryable: false });
    expect(describeFailure(new LlmError("all_models_failed", true))).toMatchObject({ code: "all_models_failed", retryable: true });
  });
  it("never leaks the message of an unknown error", () => {
    const f = describeFailure(new Error("secret sk-live-123 in prompt"));
    expect(f.message).not.toContain("sk-live-123");
    expect(f).toMatchObject({ code: "unexpected", retryable: true });
  });
});
