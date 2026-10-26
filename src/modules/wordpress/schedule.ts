/**
 * Spreading a batch over days ("drip"): N articles per day inside a daily time window, in the SITE's own clock
 * (WordPress converts it; we never need the site's time zone). Times are spread evenly through the window with a small repeatable
 * offset so they do not look machine-made; they are strictly increasing and never leave the window.
 */
export type SchedulePlan = { count: number; startDate: string; perDay: number; from: string; until: string };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function addDays(date: string, n: number): string {
  const m = DATE.exec(date);
  if (!m) throw new Error("bad date");
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return d.toISOString().slice(0, 10);
}
export const validDate = (s: string) => { const m = DATE.exec(s); return !!m && addDays(s, 0) === s; };

/** Small repeatable pseudo-random in [0,1) from an index (no Math.random: same input, same plan). */
const jitter = (i: number) => { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

export function planSchedule(p: SchedulePlan): { ok: true; times: string[] } | { ok: false; error: string } {
  if (!Number.isInteger(p.count) || p.count < 1 || p.count > 100) return { ok: false, error: "count" };
  if (!validDate(p.startDate)) return { ok: false, error: "date" };
  if (!Number.isInteger(p.perDay) || p.perDay < 1 || p.perDay > 10) return { ok: false, error: "per_day" };
  if (!TIME.test(p.from) || !TIME.test(p.until)) return { ok: false, error: "window" };
  const a = mins(p.from), b = mins(p.until);
  if (b - a < p.perDay * 10) return { ok: false, error: "window_short" }; // at least 10 minutes per article
  const times: string[] = [];
  for (let k = 0; k < p.count; k++) {
    const day = Math.floor(k / p.perDay);
    const onDay = Math.min(p.perDay, p.count - day * p.perDay);
    const slot = k % p.perDay;
    const width = (b - a) / onDay;
    const wiggle = (jitter(k + 1) - 0.5) * Math.min(width * 0.5, 40); // at most +-20 minutes, never past half a slot
    const m = Math.round(a + (slot + 0.5) * width + wiggle);
    times.push(`${addDays(p.startDate, day)}T${hhmm(Math.max(a, Math.min(b, m)))}`);
  }
  return { ok: true, times };
}
