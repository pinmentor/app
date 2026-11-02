import Link from "next/link";
import type { LadderStep } from "@/lib/home/stepper";

/** The 8-step ladder (see lib/home/stepper.ts). Done = ✓, now = highlighted link, locked/soon = quiet text with the reason. */
export function Stepper({ steps }: { steps: LadderStep[] }) {
  return (
    <nav aria-label="Your steps" className="pm-ladder-wrap">
      <ol className="pm-ladder">
        {steps.map((s) => {
          const mark = s.state === "done" ? "✓" : String(s.n);
          const body = (
            <>
              <span className="pm-ladder-n" aria-hidden="true">{mark}</span>
              <span className="pm-ladder-t">
                <b>{s.label}</b>
                {s.note ? <small>{s.note}</small> : null}
              </span>
            </>
          );
          return (
            <li key={s.key} className={`pm-ladder-step pm-ladder-${s.state}`} aria-current={s.state === "now" ? "step" : undefined}>
              {s.href && s.state !== "locked" && s.state !== "soon" ? <Link href={s.href}>{body}</Link> : <span className="pm-ladder-in">{body}</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
