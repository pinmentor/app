/** Progress of a batch run, from the article rows (pure, so the page and the tests share it). */
export type ArticleStatus = "queued" | "writing" | "ready" | "failed" | "canceled";
export type ProgressCounts = { total: number; queued: number; writing: number; ready: number; failed: number; canceled: number; open: number; done: number };

export function progressCounts(statuses: readonly string[]): ProgressCounts {
  const c = { total: statuses.length, queued: 0, writing: 0, ready: 0, failed: 0, canceled: 0 };
  for (const s of statuses) if (s === "queued" || s === "writing" || s === "ready" || s === "failed" || s === "canceled") c[s]++;
  const open = c.queued + c.writing;
  return { ...c, open, done: c.total - open };
}

/** Maps a database error code of the batch-run functions to a short flash code for the redirect. */
export function runFlash(code: string | undefined): string {
  switch (code) {
    case "PM005": return "norate";
    case "PM001": return "credits";
    case "PM003": return "locked";
    case "PM004": return "gone";
    case "42501": return "forbidden";
    default: return "error";
  }
}
