import { z } from "zod";

/**
 * Ground truth for "do these two keywords want the same page?" is what Google ranks (PLAN 3.6 layer 3), asked
 * with location and language set. The LLM's built-in web search is NOT a SerpProvider (US-biased, noisy).
 */
export type SerpQuery = { keyword: string; locationName: string; languageCode: string };
export type SerpResult = { keyword: string; urls: string[] };
export type SerpProvider = {
  id: string;
  search(q: SerpQuery): Promise<SerpResult>;
};

/** Same page regardless of tracking params, fragments, www., trailing slash or scheme. */
export function canonicalUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${host}${path}`;
  } catch {
    return null;
  }
}

export function serpOverlap(a: SerpResult, b: SerpResult, topN = 10): { common: number; urls: string[] } {
  const set = new Set(a.urls.slice(0, topN).map(canonicalUrl).filter((x): x is string => x !== null));
  const urls = [...new Set(b.urls.slice(0, topN).map(canonicalUrl).filter((x): x is string => x !== null && set.has(x)))];
  return { common: urls.length, urls };
}

/** PLAN 3.6: 3-4+ shared top-10 URLs means Google treats the two as one intent. 0-1 means different. */
export function serpVerdict(common: number): "same" | "related" | "different" {
  if (common >= 4) return "same";
  if (common >= 2) return "related";
  return "different";
}

const dataForSeoResponse = z.object({
  status_code: z.number(),
  tasks: z
    .array(
      z.object({
        status_code: z.number(),
        result: z
          .array(z.object({ items: z.array(z.object({ type: z.string(), url: z.string().optional() })).nullable().optional() }))
          .nullable()
          .optional(),
      }),
    )
    .optional(),
});

/**
 * DataForSEO "Google organic live" adapter. NOT yet verified against the live API (no account/deposit yet): the
 * request and response shapes follow their public docs and are covered by a fixture test only. Run
 * `serp:smoke` once with real credentials before relying on it.
 */
export function dataForSeoProvider(login: string, password: string, fetchImpl: typeof fetch = fetch): SerpProvider {
  const auth = `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`;
  return {
    id: "dataforseo",
    async search(q) {
      const res = await fetchImpl("https://api.dataforseo.com/v3/serp/google/organic/live/regular", {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify([{ keyword: q.keyword, location_name: q.locationName, language_code: q.languageCode, depth: 10 }]),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`serp_http_${res.status}`);
      const parsed = dataForSeoResponse.safeParse(await res.json());
      if (!parsed.success || parsed.data.status_code !== 20000) throw new Error("serp_bad_response");
      const items = parsed.data.tasks?.[0]?.result?.[0]?.items ?? [];
      return { keyword: q.keyword, urls: items.filter((i) => i.type === "organic" && i.url).map((i) => i.url!) };
    },
  };
}

/** In-memory provider for tests and for replaying recorded SERPs. */
export function fixtureSerp(table: Record<string, string[]>): SerpProvider {
  return { id: "fixture", async search(q) { return { keyword: q.keyword, urls: table[q.keyword] ?? [] }; } };
}
