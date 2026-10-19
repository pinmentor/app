import type { Edge } from "./silo";

/**
 * Internal link plan (PLAN §3.8): every item -> its silo's pillar + 2-5 siblings; the pillar -> all its children.
 * Siblings are the most similar items of the same silo (from the neighbour graph); when the graph gives fewer than
 * two, the nearest items by priority order fill in, so no item is left without links.
 */
export type LinkItem = { id: string; keyword: string; variants: string[]; siloIndex: number; priorityRank: number };
export type LinkPlan = { pillar: string | null; siblings: string[]; children: string[]; anchors: string[] };

export const MIN_SIBLINGS = 2;
export const MAX_SIBLINGS = 5;

/** Anchor text suggestions: the keyword, up to two variants, and a short form (first 4 words) when different. */
export function anchorSuggestions(keyword: string, variants: string[]): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    const t = s.trim();
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  add(keyword);
  variants.slice(0, 2).forEach(add);
  const short = keyword.split(/\s+/).slice(0, 4).join(" ");
  if (short.split(/\s+/).length >= 2 && short.length < keyword.length) add(short);
  return out.slice(0, 4);
}

/**
 * `silos`: for each silo, the index (into `items`) of its pillar. Edges are over item indexes. Deterministic.
 */
export function buildLinkPlans(items: LinkItem[], pillarIndexOfSilo: Map<number, number>, edges: Edge[]): LinkPlan[] {
  const neighbours = new Map<number, { j: number; sim: number }[]>();
  for (const e of edges) {
    if (items[e.a]?.siloIndex !== items[e.b]?.siloIndex) continue;
    (neighbours.get(e.a) ?? neighbours.set(e.a, []).get(e.a)!).push({ j: e.b, sim: e.sim });
    (neighbours.get(e.b) ?? neighbours.set(e.b, []).get(e.b)!).push({ j: e.a, sim: e.sim });
  }
  const bySilo = new Map<number, number[]>();
  items.forEach((x, i) => (bySilo.get(x.siloIndex) ?? bySilo.set(x.siloIndex, []).get(x.siloIndex)!).push(i));

  return items.map((item, i) => {
    const pillarIdx = pillarIndexOfSilo.get(item.siloIndex);
    const isPillar = pillarIdx === i;
    const mates = (bySilo.get(item.siloIndex) ?? []).filter((j) => j !== i);
    const anchors = anchorSuggestions(item.keyword, item.variants);
    if (isPillar) {
      return { pillar: null, siblings: [], children: mates.map((j) => items[j]!.id), anchors };
    }
    const ranked = (neighbours.get(i) ?? []).sort((x, y) => y.sim - x.sim || x.j - y.j).map((n) => n.j).filter((j) => j !== pillarIdx);
    const chosen: number[] = [];
    for (const j of ranked) if (!chosen.includes(j) && chosen.length < MAX_SIBLINGS) chosen.push(j);
    if (chosen.length < MIN_SIBLINGS) {
      const fill = mates
        .filter((j) => j !== pillarIdx && !chosen.includes(j))
        .sort((x, y) => Math.abs(items[x]!.priorityRank - item.priorityRank) - Math.abs(items[y]!.priorityRank - item.priorityRank) || x - y);
      for (const j of fill) if (chosen.length < MIN_SIBLINGS) chosen.push(j);
    }
    return { pillar: pillarIdx === undefined ? null : items[pillarIdx]!.id, siblings: chosen.map((j) => items[j]!.id), children: [], anchors };
  });
}
