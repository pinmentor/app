import { describe, expect, it } from "vitest";
import { stepper, type StepperInput } from "./stepper";

const none: StepperInput = { sitesConnected: 0, mapsReady: 0, itemsApproved: 0, articlesReady: 0, draftsSent: 0 };
const state = (i: StepperInput) => stepper(i).steps.map((s) => s.state);

describe("stepper", () => {
  it("has the 8 steps in the fixed order", () => {
    expect(stepper(none).steps.map((s) => s.label)).toEqual(["Website", "Keywords & Map", "Review & Approve", "Write", "Pictures", "Publish", "Pins", "Schedule & Results"]);
    expect(stepper(none).steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("a new user is at step 1, everything built after it is locked with the reason", () => {
    const { steps, now } = stepper(none);
    expect(now).toBe(0);
    expect(state(none)).toEqual(["now", "locked", "locked", "locked", "soon", "locked", "soon", "soon"]);
    expect(steps[1]!.note).toBe("Opens after Website");
    expect(steps[5]!.note).toBe("Opens after Website");
    expect(steps[1]!.href).toBeNull();
  });

  it("moves on as the counts grow and skips the not-yet-built Pictures step", () => {
    const afterWrite = { sitesConnected: 1, mapsReady: 1, itemsApproved: 5, articlesReady: 2, draftsSent: 0 };
    const r = stepper(afterWrite);
    expect(r.steps[r.now]!.key).toBe("publish");
    expect(state(afterWrite)).toEqual(["done", "done", "done", "done", "soon", "now", "soon", "soon"]);
  });

  it("soon steps never carry a link, a now state or a lock text about other steps", () => {
    const s = stepper(none).steps.filter((x) => x.state === "soon");
    expect(s.map((x) => x.key)).toEqual(["pictures", "pins", "schedule"]);
    for (const x of s) {
      expect(x.href).toBeNull();
      expect(x.note).toBe("Coming soon");
    }
  });

  it("when every built step is done there is no current step", () => {
    const all = { sitesConnected: 1, mapsReady: 1, itemsApproved: 1, articlesReady: 1, draftsSent: 1 };
    expect(stepper(all).now).toBe(-1);
    expect(state(all).filter((x) => x === "now" || x === "locked")).toEqual([]);
  });

  it("a later step that is already done stays done even if an earlier one is not (e.g. site removed)", () => {
    const odd = { sitesConnected: 0, mapsReady: 1, itemsApproved: 1, articlesReady: 1, draftsSent: 0 };
    expect(state(odd)).toEqual(["now", "done", "done", "done", "soon", "locked", "soon", "soon"]);
  });
});
