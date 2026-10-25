/**
 * The admin home: what needs attention right now (most urgent first) and the one-time setup line.
 * Pure function of counts the page reads, so the wording and the order are testable.
 */
export type AdminInput = {
  encryptionKey: "ok" | "missing" | "invalid";
  keysSet: number;
  articleWriteRate: number | null;
  deadJobs7d: number;
  failedArticles7d: number;
  stuckQueued: number;
  mapsTotal: number;
};
export type Attention = { id: string; tone: "bad" | "warn"; text: string; href: string; cta: string };
export type SetupStep = { key: string; title: string; hint: string; done: boolean; href: string; cta: string };

export function adminAttention(i: AdminInput): Attention[] {
  const out: Attention[] = [];
  if (i.encryptionKey !== "ok") out.push({ id: "enc", tone: "bad", text: i.encryptionKey === "missing" ? "ENCRYPTION_KEY is missing in Vercel: keys and WordPress passwords cannot be stored." : "ENCRYPTION_KEY has the wrong size (needs 32 random bytes, base64).", href: "/admin/integrations", cta: "Open API keys" });
  if (i.keysSet === 0) out.push({ id: "keys", tone: "bad", text: "No AI provider key is set: nothing can be written.", href: "/admin/integrations", cta: "Add a key" });
  if (i.articleWriteRate === null) out.push({ id: "rate", tone: "warn", text: "No price for writing an article: writing is blocked until you set one (0 = free).", href: "/admin/credits", cta: "Set the price" });
  if (i.deadJobs7d > 0) out.push({ id: "dead", tone: "bad", text: `${i.deadJobs7d} job${i.deadJobs7d === 1 ? "" : "s"} failed for good in the last 7 days.`, href: "/admin/jobs", cta: "See jobs" });
  if (i.failedArticles7d > 0) out.push({ id: "art", tone: "warn", text: `${i.failedArticles7d} article${i.failedArticles7d === 1 ? "" : "s"} failed in the last 7 days (not charged).`, href: "/admin/jobs", cta: "See jobs" });
  if (i.stuckQueued > 0) out.push({ id: "queue", tone: "warn", text: `${i.stuckQueued} job${i.stuckQueued === 1 ? " is" : "s are"} waiting for more than 10 minutes.`, href: "/admin/jobs", cta: "See jobs" });
  return out;
}

export function adminSetup(i: AdminInput): { steps: SetupStep[]; now: number } {
  const steps: SetupStep[] = [
    { key: "keys", title: "Add an AI provider key", hint: "At least one of Anthropic, OpenAI or Gemini. Add two for a real second-opinion language review.", done: i.keysSet > 0 && i.encryptionKey === "ok", href: "/admin/integrations", cta: "Open API keys" },
    { key: "price", title: "Set the price of an article", hint: "Credits taken for one finished article. Measure the real AI cost first, then decide.", done: i.articleWriteRate !== null, href: "/admin/credits", cta: "Open credit prices" },
    { key: "map", title: "Start a topical map", hint: "Pick a topic and language; the map is built in stages and then appears for review.", done: i.mapsTotal > 0, href: "/admin/maps", cta: "Open topical maps" },
  ];
  return { steps, now: steps.findIndex((s) => !s.done) };
}
