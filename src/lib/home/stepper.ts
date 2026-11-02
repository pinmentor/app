/**
 * The 8-step ladder shown at the top of every signed-in page ("what comes after what").
 * Pure function of counts, so the order, the lock texts and the "now" step are testable.
 *
 *   1 Website → 2 Keywords & Map → 3 Review & Approve → 4 Write → 5 Pictures → 6 Publish → 7 Pins → 8 Schedule & Results
 *
 * Steps that are not built yet (Pictures, Pins, Schedule & Results) are "soon": they are shown, never "now", never block
 * the steps after them, and say when they arrive. A built step that cannot be started yet is "locked" and says what opens it.
 */
export type StepperInput = {
  sitesConnected: number;
  mapsReady: number;
  itemsApproved: number;
  articlesReady: number;
  draftsSent: number;
};

export type StepKey = "website" | "map" | "review" | "write" | "pictures" | "publish" | "pins" | "schedule";
export type StepState = "done" | "now" | "locked" | "soon";
export type LadderStep = { key: StepKey; n: number; label: string; state: StepState; href: string | null; note: string | null };

type Def = { key: StepKey; label: string; href: string; soon?: string };

const DEFS: Def[] = [
  { key: "website", label: "Website", href: "/sites" },
  { key: "map", label: "Keywords & Map", href: "/maps" },
  { key: "review", label: "Review & Approve", href: "/maps" },
  { key: "write", label: "Write", href: "/maps" },
  { key: "pictures", label: "Pictures", href: "/articles", soon: "Coming soon" },
  { key: "publish", label: "Publish", href: "/articles" },
  { key: "pins", label: "Pins", href: "/articles", soon: "Coming soon" },
  { key: "schedule", label: "Schedule & Results", href: "/articles", soon: "Coming soon" },
];

export function stepper(i: StepperInput): { steps: LadderStep[]; now: number } {
  const done: Record<StepKey, boolean> = {
    website: i.sitesConnected > 0,
    map: i.mapsReady > 0,
    review: i.itemsApproved > 0,
    write: i.articlesReady > 0,
    pictures: false,
    publish: i.draftsSent > 0,
    pins: false,
    schedule: false,
  };
  const now = DEFS.findIndex((d) => !d.soon && !done[d.key]);
  const nowLabel = now === -1 ? "" : DEFS[now]!.label;
  const steps = DEFS.map((d, idx): LadderStep => {
    const n = idx + 1;
    if (d.soon) return { key: d.key, n, label: d.label, state: "soon", href: null, note: d.soon };
    if (done[d.key]) return { key: d.key, n, label: d.label, state: "done", href: d.href, note: null };
    if (idx === now) return { key: d.key, n, label: d.label, state: "now", href: d.href, note: null };
    return { key: d.key, n, label: d.label, state: "locked", href: null, note: `Opens after ${nowLabel}` };
  });
  return { steps, now };
}
