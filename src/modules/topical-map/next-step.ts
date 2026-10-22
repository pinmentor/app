/**
 * "What do I do next?" for one map, as ONE answer. The whole writing flow is a straight line:
 *   1 Approve  ->  2 Batch  ->  3 Write  ->  4 Check
 * and this function says which step the map is at and the single action that moves it on. Pure, so it is testable and
 * every page shows the same answer. It only reads the state; it never decides a price or changes a status.
 */
export type NextInput = {
  finished: boolean;
  items: { status: string; batch_id: string | null }[];
  batches: { id: string; name: string; status: string }[];
  articles: { id: string; batch_id: string; status: string; qa?: { verdict?: string } }[];
  /** Batches the app would suggest for the approved, unbatched items (batching.ts). */
  suggested: number;
};

export type NextAction =
  | { kind: "link"; label: string; href: string }
  | { kind: "make_batches"; label: string }
  | { kind: "write_batch"; label: string; batchId: string }
  | { kind: "none" };

export type NextStep = { step: 0 | 1 | 2 | 3 | 4; title: string; hint: string; action: NextAction };

export const STEP_NAMES = ["Approve", "Batch", "Write", "Check"] as const;

const light = (v: string | undefined) => (v === "pass" ? 0 : v === "fail" ? 2 : 1); // 0 green, 1 yellow, 2 red

export function nextStep(map: NextInput, runId: string): NextStep {
  if (!map.finished) return { step: 0, title: "Your map is still being built", hint: "It appears here for review when it is finished.", action: { kind: "none" } };

  const proposed = map.items.filter((i) => i.status === "proposed").length;
  const approvedFree = map.items.filter((i) => i.status === "approved" && !i.batch_id).length;
  const running = map.batches.filter((b) => b.status === "running");
  const planned = map.batches.filter((b) => b.status === "planned");
  const inBatch = (id: string) => map.articles.filter((a) => a.batch_id === id);

  if (running.length > 0) {
    const all = running.flatMap((b) => inBatch(b.id));
    const done = all.filter((a) => a.status !== "queued" && a.status !== "writing").length;
    return {
      step: 3,
      title: `Writing: ${done} of ${all.length} articles done`,
      hint: "This takes a few minutes. Refresh this page to see progress.",
      action: { kind: "link", label: "Refresh", href: `/maps/${runId}/batches` },
    };
  }
  if (planned.length > 0) {
    const b = planned[0]!;
    const n = map.items.filter((i) => i.batch_id === b.id).length;
    return {
      step: 3,
      title: `Write the batch “${b.name}” (${n} article${n === 1 ? "" : "s"})`,
      hint: planned.length > 1 ? `${planned.length} batches are waiting. Start with this one.` : "The articles are written one by one; you only pay for the ones that come out ready.",
      action: { kind: "write_batch", label: "Write this batch", batchId: b.id },
    };
  }
  if (approvedFree > 0) {
    return {
      step: 2,
      title: `${approvedFree} approved article${approvedFree === 1 ? "" : "s"} ready to be grouped`,
      hint: "A batch is a group of articles that are written together.",
      action: map.suggested > 0 ? { kind: "make_batches", label: `Create ${map.suggested} batch${map.suggested === 1 ? "" : "es"}` } : { kind: "link", label: "Open batches", href: `/maps/${runId}/batches` },
    };
  }
  const ready = map.articles.filter((a) => a.status === "ready");
  if (ready.length > 0) {
    const attention = ready.filter((a) => light(a.qa?.verdict) > 0);
    const first = [...attention].sort((a, b) => light(b.qa?.verdict) - light(a.qa?.verdict))[0] ?? ready[0]!;
    return {
      step: 4,
      title: attention.length > 0 ? `${attention.length} of ${ready.length} written article${ready.length === 1 ? "" : "s"} need a look` : `${ready.length} article${ready.length === 1 ? " is" : "s are"} ready and passed the checks`,
      hint: "Open an article to read it, see the checks and read a translation.",
      action: { kind: "link", label: attention.length > 0 ? "Open the first one" : "Open an article", href: `/maps/${runId}/articles/${first.id}` },
    };
  }
  if (proposed > 0) {
    return { step: 1, title: `${proposed} article${proposed === 1 ? "" : "s"} waiting for your decision`, hint: "Approve the ones you want written. Reject the rest.", action: { kind: "link", label: "Go to Review", href: `/maps/${runId}` } };
  }
  return { step: 0, title: "Nothing left to do here", hint: "Every article is written or set aside.", action: { kind: "none" } };
}
