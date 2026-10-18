import { decidePair, type Thresholds, type Verdict } from "./compare";
import { cosine, type Embedder } from "./embed";
import type { IntentJudge } from "./judge";
import type { Locale } from "./lexicon";
import { normalize } from "./normalize";
import { goldPairSchema, type GoldPair } from "./schemas";

export function parseGold(jsonl: string): GoldPair[] {
  return jsonl
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      const r = goldPairSchema.safeParse(JSON.parse(l));
      if (!r.success) throw new Error(`gold line ${i + 1} is invalid: ${r.error.issues[0]?.message}`);
      return r.data;
    });
}

export type Prediction = { pair: GoldPair; predicted: Verdict; by: string; reason: string };

export async function predictAll(
  pairs: GoldPair[],
  opts: { embedder: Embedder; judge: IntentJudge; thresholds: Thresholds; locale?: Locale },
): Promise<Prediction[]> {
  const locale = opts.locale ?? "es-MX";
  const texts = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
  const vecs = await opts.embedder.embed(texts);
  const vec = new Map(texts.map((t, i) => [t, vecs[i]!]));
  const decisions = pairs.map((p) => decidePair(normalize(p.a, locale), normalize(p.b, locale), cosine(vec.get(p.a)!, vec.get(p.b)!), opts.thresholds));
  const needJudge = decisions.map((d, i) => (d.by === "needs_judge" ? i : -1)).filter((i) => i >= 0);
  const judged = needJudge.length ? await opts.judge.judge(needJudge.map((i) => ({ a: pairs[i]!.a, b: pairs[i]!.b }))) : [];
  const judgedAt = new Map(needJudge.map((i, k) => [i, judged[k]!]));
  return pairs.map((pair, i) => {
    const j = judgedAt.get(i);
    const d = decisions[i]!;
    return { pair, predicted: j ? j.verdict : d.verdict, by: j ? "judge" : d.by, reason: j ? j.reason : d.reason };
  });
}

export type Metrics = {
  n: number;
  excludedUncertain: number;
  /** "merge" = predicted/labelled `same`. Precision: of the merges we make, how many are right. */
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  fp_pairs: Prediction[];
  fn_pairs: Prediction[];
  /** label -> predicted -> count */
  confusion: Record<string, Record<string, number>>;
};

export function score(preds: Prediction[]): Metrics {
  const usable = preds.filter((p) => p.pair.label !== "uncertain");
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const fpPairs: Prediction[] = [];
  const fnPairs: Prediction[] = [];
  const confusion: Metrics["confusion"] = {};
  for (const p of usable) {
    const truth = p.pair.label === "same";
    const pred = p.predicted === "same";
    if (truth && pred) tp++;
    else if (!truth && pred) {
      fp++;
      fpPairs.push(p);
    } else if (truth && !pred) {
      fn++;
      fnPairs.push(p);
    } else tn++;
    (confusion[p.pair.label] ??= {})[p.predicted] = ((confusion[p.pair.label] ?? {})[p.predicted] ?? 0) + 1;
  }
  return {
    n: usable.length,
    excludedUncertain: preds.length - usable.length,
    tp, fp, fn, tn,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    fp_pairs: fpPairs,
    fn_pairs: fnPairs,
    confusion,
  };
}

/** Thresholds a run must stay above. A change that lowers either number fails CI (PLAN 3.10). */
export type Floor = { precision: number; recall: number };

export type SweepRow = { high: number; low: number; precision: number; recall: number; fp: number; fn: number };

/**
 * Grid search of (high, low) on a set of gold pairs. Embeds once, reuses the vectors for every grid point.
 * Only the DEV split must be passed when picking thresholds (never tune on test).
 */
export async function sweepThresholds(
  pairs: GoldPair[],
  opts: { embedder: Embedder; judge: IntentJudge; locale?: Locale; highs?: number[]; lows?: number[] },
): Promise<SweepRow[]> {
  const highs = opts.highs ?? [0.8, 0.84, 0.88, 0.9, 0.92, 0.94, 0.96];
  const lows = opts.lows ?? [0.5, 0.55, 0.6, 0.65, 0.7, 0.75];
  const rows: SweepRow[] = [];
  for (const high of highs) {
    for (const low of lows) {
      if (low >= high) continue;
      const m = score(await predictAll(pairs, { embedder: opts.embedder, judge: opts.judge, thresholds: { high, low }, locale: opts.locale }));
      rows.push({ high, low, precision: m.precision, recall: m.recall, fp: m.fp, fn: m.fn });
    }
  }
  return rows;
}

/**
 * The grid point with the best recall among those meeting the precision floor (a false merge loses an article, a missed
 * merge only costs a near-duplicate that the judge or the user can still merge). Ties: fewer false merges, then higher
 * `high` (more conservative). Returns null when nothing reaches the floor.
 */
export function recommendThresholds(rows: SweepRow[], minPrecision: number): SweepRow | null {
  const ok = rows.filter((r) => r.precision >= minPrecision);
  ok.sort((a, b) => b.recall - a.recall || a.fp - b.fp || b.high - a.high || b.low - a.low);
  return ok[0] ?? null;
}
