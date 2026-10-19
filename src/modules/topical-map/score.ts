import type { Intent } from "./classify";

/**
 * S6 priority score (PLAN §3.8): demand, competition weakness, business value, Pinterest fit, seasonality, silo role.
 * Weights sum to 1; the result is 0-100 with a per-component explanation, so the editor can see WHY an item ranks.
 *
 * Honest limits: demand is the LLM's 1-5 estimate and competition weakness is neutral (0.5) until a SERP provider
 * supplies `comp_score` (PLAN §3.7). Both are marked in `notes` so nobody mistakes the score for measured data.
 */
export const WEIGHTS = { demand: 0.3, competition: 0.15, business: 0.2, pinterest: 0.2, seasonality: 0.05, siloRole: 0.1 } as const;

export type ScoreInput = {
  demandTier: number; // 1-5
  compScore?: number | null; // 0-100 competition strength; null = unknown
  articleType: "A" | "B";
  intent: Intent;
  pinterestFit: number; // 1-5
  seasonality: number; // 0-2
  siloRole: "pillar" | "supporting" | "unassigned";
};

export type ScoreDetail = {
  priority: number;
  parts: { demand: number; competition: number; business: number; pinterest: number; seasonality: number; siloRole: number };
  notes: string[];
};

const unit = (v: number, lo: number, hi: number) => Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
const round1 = (n: number) => Math.round(n * 10) / 10;

export function scoreItem(x: ScoreInput): ScoreDetail {
  const notes: string[] = ["demand is an LLM estimate, not a search volume"];
  let competition = 0.5;
  if (x.compScore === null || x.compScore === undefined) notes.push("no SERP data: competition counted as neutral");
  else competition = 1 - unit(x.compScore, 0, 100);

  const business = x.articleType === "B" ? (x.intent === "transactional" ? 1 : 0.8) : 0.3;
  const siloRole = x.siloRole === "pillar" ? 1 : x.siloRole === "supporting" ? 0.4 : 0.4;
  const parts = {
    demand: unit(x.demandTier, 1, 5),
    competition,
    business,
    pinterest: unit(x.pinterestFit, 1, 5),
    seasonality: x.seasonality / 2,
    siloRole,
  };
  const total =
    parts.demand * WEIGHTS.demand + parts.competition * WEIGHTS.competition + parts.business * WEIGHTS.business +
    parts.pinterest * WEIGHTS.pinterest + parts.seasonality * WEIGHTS.seasonality + parts.siloRole * WEIGHTS.siloRole;
  return {
    priority: round1(total * 100),
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 100) / 100])) as ScoreDetail["parts"],
    notes,
  };
}
