import { z } from "zod";
import type { Locale } from "./lexicon";
import { shortText, tolerantList } from "./tolerant";

/**
 * S6/S7: silo architecture (PLAN §3.8). Average-linkage agglomerative clustering over the sparse nearest-neighbour
 * graph of the primaries, with a hard size cap (15-40 items per silo) instead of a fixed cluster count.
 * Pure: the caller supplies the edges (from kw_primary_edges) and gets back index groups.
 */

export type Edge = { a: number; b: number; sim: number };
export type SiloOptions = { minSize: number; maxSize: number; minSim: number };
export const DEFAULT_SILO_OPTIONS: SiloOptions = { minSize: 15, maxSize: 40, minSim: 0.5 };

/** Both directions of the neighbour lists fold into one undirected edge (max similarity wins). Self and out-of-range edges are dropped. */
export function foldEdges(n: number, edges: Edge[]): Edge[] {
  const best = new Map<number, number>();
  for (const e of edges) {
    if (e.a === e.b || e.a < 0 || e.b < 0 || e.a >= n || e.b >= n || !Number.isFinite(e.sim)) continue;
    const lo = Math.min(e.a, e.b);
    const hi = Math.max(e.a, e.b);
    const key = lo * n + hi;
    best.set(key, Math.max(best.get(key) ?? -Infinity, e.sim));
  }
  return [...best.entries()].map(([key, sim]) => ({ a: Math.floor(key / n), b: key % n, sim })).sort((x, y) => x.a - y.a || x.b - y.b);
}

/** Groups of item indexes, each sorted ascending; groups ordered by their smallest index. Every index 0..n-1 appears exactly once. */
export function clusterSilos(n: number, edgesIn: Edge[], opts: SiloOptions = DEFAULT_SILO_OPTIONS): number[][] {
  if (n === 0) return [];
  const edges = foldEdges(n, edgesIn);
  const members = new Map<number, number[]>(Array.from({ length: n }, (_, i) => [i, [i]]));
  // sum of similarities between two clusters (missing pairs count as 0): average = sum / (|A| * |B|)
  const sums = new Map<number, Map<number, number>>(Array.from({ length: n }, (_, i) => [i, new Map()]));
  for (const e of edges) {
    sums.get(e.a)!.set(e.b, e.sim);
    sums.get(e.b)!.set(e.a, e.sim);
  }
  const size = (c: number) => members.get(c)!.length;

  const merge = (keep: number, gone: number) => {
    for (const [other, s] of sums.get(gone)!) {
      if (other === keep) continue;
      sums.get(keep)!.set(other, (sums.get(keep)!.get(other) ?? 0) + s);
      sums.get(other)!.set(keep, sums.get(keep)!.get(other)!);
      sums.get(other)!.delete(gone);
    }
    sums.get(keep)!.delete(gone);
    members.get(keep)!.push(...members.get(gone)!);
    members.delete(gone);
    sums.delete(gone);
  };

  // 1) agglomerate by best average similarity while the merged cluster fits
  for (;;) {
    let bestAvg = -1;
    let bestA = -1;
    let bestB = -1;
    for (const [a, row] of sums) {
      for (const [b, s] of row) {
        if (b <= a || size(a) + size(b) > opts.maxSize) continue;
        const avg = s / (size(a) * size(b));
        if (avg > bestAvg + 1e-12 || (Math.abs(avg - bestAvg) <= 1e-12 && (a < bestA || (a === bestA && b < bestB)))) {
          bestAvg = avg;
          bestA = a;
          bestB = b;
        }
      }
    }
    if (bestA < 0 || bestAvg < opts.minSim) break;
    merge(bestA, bestB);
  }

  // 2) undersized clusters join their closest neighbour that still fits; with no neighbour, the smallest cluster that fits
  for (;;) {
    const small = [...members.keys()].filter((c) => size(c) < opts.minSize).sort((x, y) => size(x) - size(y) || x - y);
    let merged = false;
    for (const c of small) {
      let target = -1;
      let bestAvg = -1;
      for (const [o, s] of sums.get(c)!) {
        if (size(c) + size(o) > opts.maxSize) continue;
        const avg = s / (size(c) * size(o));
        if (avg > bestAvg || (avg === bestAvg && o < target)) {
          bestAvg = avg;
          target = o;
        }
      }
      if (target < 0) {
        const fits = [...members.keys()].filter((o) => o !== c && size(c) + size(o) <= opts.maxSize).sort((x, y) => size(x) - size(y) || x - y);
        target = fits[0] ?? -1;
      }
      if (target >= 0) {
        const keep = Math.min(c, target);
        merge(keep, keep === c ? target : c);
        merged = true;
        break;
      }
    }
    if (!merged) break;
  }

  return [...members.values()].map((m) => [...m].sort((x, y) => x - y)).sort((x, y) => x[0]! - y[0]!);
}

/** The pillar is the most central item: highest total similarity to its silo mates; ties go to the shorter, then the earlier one. */
export function pickPillar(group: number[], edgesIn: Edge[], rawOf: (i: number) => string): number {
  const inGroup = new Set(group);
  const total = new Map<number, number>(group.map((i) => [i, 0]));
  for (const e of edgesIn) {
    if (!inGroup.has(e.a) || !inGroup.has(e.b) || e.a === e.b) continue;
    total.set(e.a, total.get(e.a)! + e.sim);
    total.set(e.b, total.get(e.b)! + e.sim);
  }
  return [...group].sort((x, y) => total.get(y)! - total.get(x)! || rawOf(x).length - rawOf(y).length || x - y)[0]!;
}

// ---------------------------------------------------------------------------------------------------------------------
// Silo names (one cheap LLM call per few silos)
// ---------------------------------------------------------------------------------------------------------------------
const LANG: Record<Locale, string> = { "es-MX": "Mexican Spanish", "es-US": "US Spanish", "es-ES": "Castilian Spanish", "en-US": "US English" };

export function siloNamePrompt(topic: string, locale: Locale, silos: { pillar: string; sample: string[] }[]): { system: string; prompt: string } {
  return {
    system: `You name the content silos (topic clusters) of a ${LANG[locale]} blog. For each silo give a short, natural name (2-5 words, ${LANG[locale]}, title case, no year, no brand) and a one-line gloss in English and in Bengali explaining what the silo covers. Return only JSON: [{"i":0,"name":"","gloss_en":"","gloss_bn":""}], one object per silo, same order.`,
    prompt: `Topic: ${topic}\n${silos.map((s, i) => `${i}. pillar: "${s.pillar}" | examples: ${s.sample.map((x) => `"${x}"`).join(", ")}`).join("\n")}`,
  };
}

export const siloNameResponseSchema = tolerantList(
  z.object({
    i: z.coerce.number().int().min(0),
    name: z.unknown().transform(shortText(120)),
    gloss_en: z.unknown().transform(shortText(300)),
    gloss_bn: z.unknown().transform(shortText(300)),
  }),
);

/** A name from the model, or the pillar keyword capitalised when the model gave none (never an empty silo name). */
export function siloNameOrFallback(name: string | undefined, pillarRaw: string): string {
  const n = (name ?? "").trim();
  if (n.length >= 2) return n;
  const p = pillarRaw.trim();
  return p.length > 0 ? p.charAt(0).toUpperCase() + p.slice(1) : "Silo";
}
