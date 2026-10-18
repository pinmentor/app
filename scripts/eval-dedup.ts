/* Usage: pnpm eval:dedup [--split dev|test|all] [--verbose]
 *        node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/eval-dedup.ts --embedder live --sweep
 * Default: offline lexical baseline (no API keys). Measures merge precision/recall of S3+S4 against
 * eval/golden/es-peinados.jsonl; exit code 1 if a floor from eval/floors.json is not met on the TEST split.
 *
 * --embedder live  uses the real embedding model through the registry (needs NEXT_PUBLIC_SUPABASE_URL,
 *                  SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY, PM_WORKSPACE_ID; costs a few cents).
 * --sweep          grid-searches (high, low) on the DEV split only, prints the recommendation (precision floor from
 *                  floors.json), then reports that choice on the TEST split once. Floors apply to the lexical baseline
 *                  only, so a live run never fails the exit code. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_THRESHOLDS } from "../src/modules/topical-map/dedup";
import { lexicalEmbedder, type Embedder } from "../src/modules/topical-map/embed";
import { parseGold, predictAll, recommendThresholds, score, sweepThresholds, type Metrics } from "../src/modules/topical-map/eval";
import { conservativeJudge } from "../src/modules/topical-map/judge";

const root = join(__dirname, "..");
const args = process.argv.slice(2);
const splitArg = args.includes("--split") ? args[args.indexOf("--split") + 1] : "all";
const verbose = args.includes("--verbose");
const live = args.includes("--embedder") && args[args.indexOf("--embedder") + 1] === "live";
const sweep = args.includes("--sweep");

async function liveEmbedder(): Promise<Embedder> {
  const workspaceId = process.env.PM_WORKSPACE_ID;
  if (!workspaceId) throw new Error("PM_WORKSPACE_ID is required for --embedder live (the workspace the cost is logged to)");
  const { embedTexts } = await import("../src/modules/llm/embed");
  return { id: "live", embed: async (texts) => (await embedTexts({ workspaceId, texts })).vectors };
}

function show(name: string, m: Metrics) {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(`\n${name}: ${m.n} pairs (${m.excludedUncertain} uncertain excluded)`);
  console.log(`  merge precision ${pct(m.precision)}   recall ${pct(m.recall)}   (tp ${m.tp}, fp ${m.fp}, fn ${m.fn}, tn ${m.tn})`);
  if (verbose || m.fp > 0) for (const p of m.fp_pairs) console.log(`  FALSE MERGE  "${p.pair.a}" | "${p.pair.b}"  [${p.pair.label}->same by ${p.by}: ${p.reason}]`);
  if (verbose) for (const p of m.fn_pairs) console.log(`  MISSED MERGE "${p.pair.a}" | "${p.pair.b}"  [predicted ${p.predicted} by ${p.by}: ${p.reason}]`);
}

async function main() {
  const gold = parseGold(readFileSync(join(root, "eval/golden/es-peinados.jsonl"), "utf8"));
  const floors = JSON.parse(readFileSync(join(root, "eval/floors.json"), "utf8")) as { precision: number; recall: number };
  const embedder = live ? await liveEmbedder() : lexicalEmbedder("es-MX");
  let thresholds = DEFAULT_THRESHOLDS;
  if (sweep) {
    const rows = await sweepThresholds(gold.filter((g) => g.split === "dev"), { embedder, judge: conservativeJudge, locale: "es-MX" });
    console.log("\nSweep on DEV (high, low -> precision, recall, false merges):");
    for (const r of rows) console.log(`  high ${r.high.toFixed(2)}  low ${r.low.toFixed(2)}  ->  P ${(r.precision * 100).toFixed(1)}%  R ${(r.recall * 100).toFixed(1)}%  fp ${r.fp}  fn ${r.fn}`);
    const best = recommendThresholds(rows, floors.precision);
    if (!best) {
      console.log(`\nNo grid point reaches precision ${floors.precision} on dev. Keep the conservative placeholders.`);
    } else {
      console.log(`\nRECOMMENDED: high ${best.high}, low ${best.low}  (dev P ${(best.precision * 100).toFixed(1)}%, R ${(best.recall * 100).toFixed(1)}%)`);
      thresholds = { high: best.high, low: best.low };
    }
  }
  const preds = await predictAll(gold, { embedder, judge: conservativeJudge, thresholds, locale: "es-MX" });

  const dev = score(preds.filter((p) => p.pair.split === "dev"));
  const test = score(preds.filter((p) => p.pair.split === "test"));
  console.log(`Dedup eval: ${live ? "LIVE embedder" : "lexical baseline (offline)"}, thresholds ${thresholds.high}/${thresholds.low}, gold status:`, [...new Set(gold.map((g) => g.status))].join(","));
  if (splitArg !== "test") show("dev  (used for tuning)", dev);
  if (splitArg !== "dev") show("test (report only)", test);
  console.log(`\nfloors (test): precision >= ${floors.precision}, recall >= ${floors.recall}`);
  if (live) {
    console.log("RESULT: live run (floors apply to the offline baseline only; judge = none, borderline pairs stay separate)");
    process.exit(0);
  }
  const ok = test.precision >= floors.precision && test.recall >= floors.recall;
  console.log(ok ? "RESULT: OK" : "RESULT: BELOW FLOOR");
  process.exit(ok ? 0 : 1);
}
void main();
