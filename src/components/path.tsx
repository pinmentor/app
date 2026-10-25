import Link from "next/link";

type Row = { key: string; title: string; hint: string; done: boolean; href: string; cta: string; doneText?: string };

/**
 * The step line shared by the user dashboard and the admin overview. Finished steps are one quiet line, the first unfinished
 * step is big and carries the ONE main button, later steps are only a title (no button, nothing to decide yet).
 */
export function PathList({ steps, now }: { steps: Row[]; now: number }) {
  return (
    <ol className="pm-path">
      {steps.map((s, i) => {
        const state = s.done ? "done" : i === now ? "now" : "later";
        return (
          <li key={s.key} className={`pm-path-row pm-path-${state}`} aria-current={state === "now" ? "step" : undefined}>
            <span className="pm-path-n">{s.done ? "✓" : i + 1}</span>
            <div>
              <h3>{s.title}</h3>
              {state === "now" ? <p>{s.hint}</p> : null}
              {state === "done" && s.doneText ? <p>{s.doneText}</p> : null}
            </div>
            {state === "now" ? (
              <Link href={s.href} className="pm-btn pm-btn-primary pm-path-act">{s.cta}</Link>
            ) : state === "done" ? (
              <Link href={s.href} className="pm-btn pm-btn-quiet pm-btn-sm pm-path-act">Open</Link>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
