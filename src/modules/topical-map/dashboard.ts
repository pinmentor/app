/**
 * Pure logic of the project dashboard (PLAN §4.1 / §4.3): item statuses grouped into the four views, counters, and the
 * progress of a silo. Anything that is not a known status is counted in `total` only (never silently dropped from it).
 */
export const STATUS_GROUPS = {
  remaining: ["proposed", "approved", "in_batch"],
  inProgress: ["writing", "draft_ready", "in_review"],
  completed: ["scheduled", "published", "pins_pending", "done"],
  setAside: ["rejected", "already_exists"],
} as const;

export type GroupName = keyof typeof STATUS_GROUPS;
export type Counters = Record<GroupName, number> & { total: number };

export function groupOf(status: string): GroupName | null {
  for (const g of Object.keys(STATUS_GROUPS) as GroupName[]) if ((STATUS_GROUPS[g] as readonly string[]).includes(status)) return g;
  return null;
}

export function counters(statuses: readonly string[]): Counters {
  const c: Counters = { remaining: 0, inProgress: 0, completed: 0, setAside: 0, total: statuses.length };
  for (const s of statuses) {
    const g = groupOf(s);
    if (g) c[g] += 1;
  }
  return c;
}

/** Progress of one silo: completed / (everything that is not set aside). An empty silo is 0 of 0 = 0%. */
export function siloProgress(statuses: readonly string[]): { done: number; of: number; pct: number } {
  const c = counters(statuses);
  const of = c.remaining + c.inProgress + c.completed;
  return { done: c.completed, of, pct: of === 0 ? 0 : Math.round((c.completed / of) * 100) };
}
