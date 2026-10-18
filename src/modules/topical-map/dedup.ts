import { decidePair, type PairDecision, type Thresholds, type Verdict } from "./compare";
import { cosine, type Embedder } from "./embed";
import type { IntentJudge } from "./judge";
import type { Locale } from "./lexicon";
import { normalize, type Normalized } from "./normalize";
import type { Candidate } from "./schemas";

export const DEFAULT_THRESHOLDS: Thresholds = { high: 0.88, low: 0.6 };

export type DedupGroup = {
  primary: Candidate;
  /** Other phrasings of the same intent. They feed headings/secondary keywords; they never become articles. */
  variants: Candidate[];
  reasons: string[];
};

export type PairLogEntry = { a: string; b: string; verdict: Verdict; by: PairDecision["by"] | "judge"; reason: string; cosine: number };

export type DedupResult = {
  groups: DedupGroup[];
  /** parent_child links between primaries (decision separate vs section is S5+). */
  parentChild: { parent: string; child: string }[];
  pairs: PairLogEntry[];
  stats: { input: number; groups: number; merged: number; judged: number };
};

class UnionFind {
  private p: number[];
  constructor(n: number) {
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.p[x] !== x) {
      this.p[x] = this.p[this.p[x]!]!;
      x = this.p[x]!;
    }
    return x;
  }
  union(a: number, b: number) {
    this.p[this.find(a)] = this.find(b);
  }
}

/** Primary = strongest demand signal, then the shortest (clearest) phrase, then alphabetical so runs are reproducible. */
function pickPrimary(members: Candidate[]): Candidate {
  return [...members].sort(
    (x, y) => (y.demandTier ?? 0) - (x.demandTier ?? 0) || x.raw.length - y.raw.length || x.raw.localeCompare(y.raw),
  )[0]!;
}

/**
 * Turns pairwise verdicts into groups. Pure: shared by the in-memory dedupe() (eval, tests) and the DB-backed
 * S4 finalize stage, so both always pick primaries and parent_child links the same way.
 */
export function assembleGroups(
  candidates: Candidate[],
  norm: Normalized[],
  edges: { same: [number, number][]; parentChild: [number, number][] },
  pairs: PairLogEntry[],
): { groups: DedupGroup[]; parentChild: DedupResult["parentChild"] } {
  const uf = new UnionFind(candidates.length);
  for (const [i, j] of edges.same) uf.union(i, j);
  const pc = edges.parentChild;

  const members = new Map<number, Candidate[]>();
  candidates.forEach((c, i) => {
    const r = uf.find(i);
    members.set(r, [...(members.get(r) ?? []), c]);
  });
  const primaryByRoot = new Map<number, Candidate>();
  const groups: DedupGroup[] = [...members.entries()].map(([root, m]) => {
    const primary = pickPrimary(m);
    primaryByRoot.set(root, primary);
    return {
      primary,
      variants: m.filter((x) => x !== primary),
      reasons: pairs.filter((p) => p.verdict === "same" && m.some((x) => x.raw === p.a) && m.some((x) => x.raw === p.b)).map((p) => p.reason),
    };
  });

  const primaryOf = (i: number) => primaryByRoot.get(uf.find(i))?.raw;
  const seen = new Set<string>();
  const parentChild: DedupResult["parentChild"] = [];
  for (const [i, j] of pc) {
    const a = primaryOf(i);
    const b = primaryOf(j);
    if (!a || !b || a === b) continue;
    // the keyword with fewer content words is the parent
    const [parent, child] = norm[i]!.tokens.length <= norm[j]!.tokens.length ? [a, b] : [b, a];
    const k = `${parent}\u0000${child}`;
    if (!seen.has(k)) {
      seen.add(k);
      parentChild.push({ parent, child });
    }
  }

  return { groups, parentChild };
}

/**
 * S3 + S4 over a candidate pool. O(n^2) pairwise cosine is fine for the eval and for pools up to a few thousand;
 * production swaps this loop for a pgvector neighbour query without changing the decision logic.
 */
export async function dedupe(
  candidates: Candidate[],
  opts: { embedder: Embedder; judge: IntentJudge; thresholds?: Thresholds; locale?: Locale },
): Promise<DedupResult> {
  const t = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const locale = opts.locale ?? "es-MX";
  const norm = candidates.map((c) => normalize(c.raw, locale));
  const vecs = await opts.embedder.embed(candidates.map((c) => c.raw));

  const same: [number, number][] = [];
  const pairs: PairLogEntry[] = [];
  const pc: [number, number][] = [];
  const borderline: { i: number; j: number; d: PairDecision }[] = [];

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const cos = cosine(vecs[i]!, vecs[j]!);
      const d = decidePair(norm[i]!, norm[j]!, cos, t);
      if (d.by === "needs_judge") {
        borderline.push({ i, j, d });
        continue;
      }
      if (d.verdict === "same") same.push([i, j]);
      if (d.verdict === "parent_child") pc.push([i, j]);
      if (d.verdict !== "different" || d.by === "rule") {
        pairs.push({ a: candidates[i]!.raw, b: candidates[j]!.raw, verdict: d.verdict, by: d.by, reason: d.reason, cosine: d.cosine });
      }
    }
  }

  if (borderline.length > 0) {
    const out = await opts.judge.judge(borderline.map(({ i, j }) => ({ a: candidates[i]!.raw, b: candidates[j]!.raw })));
    borderline.forEach(({ i, j, d }, k) => {
      const r = out[k] ?? { verdict: "related" as const, reason: "no judgement" };
      if (r.verdict === "same") same.push([i, j]);
      if (r.verdict === "parent_child") pc.push([i, j]);
      pairs.push({ a: candidates[i]!.raw, b: candidates[j]!.raw, verdict: r.verdict, by: "judge", reason: r.reason, cosine: d.cosine });
    });
  }

  const { groups, parentChild } = assembleGroups(candidates, norm, { same, parentChild: pc }, pairs);

  return {
    groups,
    parentChild,
    pairs,
    stats: { input: candidates.length, groups: groups.length, merged: candidates.length - groups.length, judged: borderline.length },
  };
}
