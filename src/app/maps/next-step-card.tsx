import Link from "next/link";
import { DEFAULT_BATCH_SIZE } from "@/modules/topical-map/batching";
import { nextStep, STEP_NAMES, type NextInput } from "@/modules/topical-map/next-step";
import { createAutoBatches, runBatch } from "./[id]/batches/actions";

/**
 * The one answer to "what do I do now?" shown at the top of every map page: where the map is in the straight line
 * Approve -> Batch -> Write -> Check, and the single button that moves it on. See modules/topical-map/next-step.ts.
 */
export function NextStepCard({ runId, input }: { runId: string; input: NextInput }) {
  const n = nextStep(input, runId);
  const a = n.action;
  return (
    <section className="pm-next" aria-label="Next step">
      <ol className="pm-steps">
        {STEP_NAMES.map((name, i) => (
          <li key={name} className={i + 1 < n.step ? "pm-step pm-step-done" : i + 1 === n.step ? "pm-step pm-step-now" : "pm-step"} aria-current={i + 1 === n.step ? "step" : undefined}>
            <span className="pm-step-n">{i + 1 < n.step ? "✓" : i + 1}</span>
            {name}
          </li>
        ))}
      </ol>
      <div className="pm-next-body">
        <div>
          <h2>{n.title}</h2>
          <p>{n.hint}</p>
        </div>
        {a.kind === "link" ? (
          <Link href={a.href} className="pm-btn pm-btn-primary">{a.label}</Link>
        ) : a.kind === "make_batches" ? (
          <form action={createAutoBatches}>
            <input type="hidden" name="run" value={runId} />
            <input type="hidden" name="size" value={DEFAULT_BATCH_SIZE} />
            <button type="submit" name="intent" value="all" className="pm-btn pm-btn-primary">{a.label}</button>
          </form>
        ) : a.kind === "write_batch" ? (
          <form action={runBatch}>
            <input type="hidden" name="run" value={runId} />
            <input type="hidden" name="batch" value={a.batchId} />
            <button type="submit" className="pm-btn pm-btn-primary">{a.label}</button>
          </form>
        ) : null}
      </div>
    </section>
  );
}
