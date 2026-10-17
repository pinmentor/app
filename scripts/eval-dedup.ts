/* Usage: pnpm eval:dedup [--split dev|test|all] [--verbose]
 * Measures merge precision/recall of S3+S4 against eval/golden/es-peinados.jsonl, offline (no API keys needed).
 * Exit code 1 if a floor from eval/floors.json is not met on the TEST split. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_THRESHOLDS } from "../src/modules/topical-map/dedup";
import { lexicalEmbedder } from "../src/modules/topical-map/embed";
import { parseGold, predictAll, score, type Metrics } from "../src/modules/topical-map/eval";
import { conservativeJudge } from "../src/modules/topical-map/judge";

const root = join(__dirname, "..");
const args = process.argv.slice(2);
const splitArg = args.includes("--split") ? args[args.indexOf("--split") + 1] : "all";
const verbose = args.includes("--verbose");

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
  const preds = await predictAll(gold, { embedder: lexicalEmbedder("es-MX"), judge: conservativeJudge, thresholds: DEFAULT_THRESHOLDS });

  const dev = score(preds.filter((p) => p.pair.split === "dev"));
  const test = score(preds.filter((p) => p.pair.split === "test"));
  console.log("Dedup eval: lexical baseline (offline), gold status:", [...new Set(gold.map((g) => g.status))].join(","));
  if (splitArg !== "test") show("dev  (used for tuning)", dev);
  if (splitArg !== "dev") show("test (report only)", test);
  console.log(`\nfloors (test): precision >= ${floors.precision}, recall >= ${floors.recall}`);
  const ok = test.precision >= floors.precision && test.recall >= floors.recall;
  console.log(ok ? "RESULT: OK" : "RESULT: BELOW FLOOR");
  process.exit(ok ? 0 : 1);
}
void main();
