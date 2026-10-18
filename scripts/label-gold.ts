/* Builds NEW gold-set pairs from a real map run with the two-model panel protocol (PLAN §3.10).
 *
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/label-gold.ts --run <mapRunId> [--n 200] [--out eval/golden/new-pairs.jsonl]
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY and keys for TWO providers (admin page or env).
 * Optional SERP pass for disagreements: DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD (location Mexico, language es).
 * Writes a separate JSONL file for you to review and merge into eval/golden/es-peinados.jsonl by hand; never overwrites it.
 * Honest limit: this is LLM-panel agreement, not native-speaker truth (recorded in `labeledBy`). */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { callLlm } from "../src/modules/llm/client";
import type { ProviderName } from "../src/modules/llm/errors";
import { createAdminClient } from "../src/lib/supabase/admin";
import { buildJudgePrompt, JUDGE_BATCH, JUDGE_SYSTEM } from "../src/modules/topical-map/judge";
import { labelResponseSchema, reconcile, samplePairs, splitFor, type PoolPair } from "../src/modules/topical-map/panel";
import { dataForSeoProvider, serpOverlap, type SerpProvider } from "../src/modules/topical-map/serp";
import type { Verdict } from "../src/modules/topical-map/compare";

const args = process.argv.slice(2);
const arg = (name: string, d?: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : d);
const runId = z.string().uuid().parse(arg("--run"));
const n = z.coerce.number().int().min(10).max(1000).parse(arg("--n", "200"));
const out = join(__dirname, "..", arg("--out", "eval/golden/new-pairs.jsonl")!);

const sb = createAdminClient();

async function pool(): Promise<{ workspaceId: string; pairs: PoolPair[] }> {
  const run = z.object({ workspace_id: z.string(), locale: z.string() }).parse((await sb.from("map_runs").select("workspace_id, locale").eq("id", runId).single()).data);
  const cands = z.array(z.object({ id: z.string(), raw: z.string() })).parse((await sb.from("kw_candidates").select("id, raw").eq("map_run_id", runId).limit(5000)).data);
  const text = new Map(cands.map((c) => [c.id, c.raw]));
  const stored = z
    .array(z.object({ a: z.string(), b: z.string(), cosine: z.number().nullable() }))
    .parse((await sb.from("kw_pairs").select("a, b, cosine").eq("map_run_id", runId).limit(5000)).data);
  const pairs: PoolPair[] = [];
  for (const p of stored) {
    const a = text.get(p.a);
    const b = text.get(p.b);
    if (a && b) pairs.push({ a, b, cosine: p.cosine ?? 0.7 });
  }
  // clearly-different pairs are not stored (they are the vast majority): add a deterministic spread of far pairs, cosine 0
  const raws = cands.map((c) => c.raw).sort();
  for (let i = 0; i + 37 < raws.length && pairs.length < 6000; i += 7) pairs.push({ a: raws[i]!, b: raws[i + 37]!, cosine: 0 });
  return { workspaceId: run.workspace_id, pairs };
}

async function label(workspaceId: string, task: string, avoid: ProviderName, pairs: PoolPair[]): Promise<{ verdicts: Verdict[]; models: Set<string>; providers: Set<string> }> {
  const verdicts: Verdict[] = [];
  const models = new Set<string>();
  const providers = new Set<string>();
  for (let i = 0; i < pairs.length; i += JUDGE_BATCH) {
    const chunk = pairs.slice(i, i + JUDGE_BATCH);
    const r = await callLlm({ task, workspaceId, system: JUDGE_SYSTEM, prompt: buildJudgePrompt(chunk), schema: labelResponseSchema, maxOutputTokens: 3000, temperature: 0, avoidProvider: avoid });
    models.add(r.modelKey);
    providers.add(r.provider);
    const by = new Map(r.data.map((x) => [x.i, x.verdict]));
    chunk.forEach((_, k) => verdicts.push(by.get(k) ?? "related")); // a missing answer counts as "related", never as a merge
  }
  return { verdicts, models, providers };
}

async function main() {
  const { workspaceId, pairs: all } = await pool();
  const sample = samplePairs(all, n);
  console.log(`pool ${all.length} pairs -> sample ${sample.length}`);

  // two independent labelers: A never uses OpenAI, B never uses Anthropic, so the providers differ whenever keys allow
  const A = await label(workspaceId, "intent_judge", "openai", sample);
  const B = await label(workspaceId, "map_audit", "anthropic", sample);
  const overlap = [...A.providers].filter((p) => B.providers.has(p));
  if (overlap.length > 0) throw new Error(`both labelers used ${overlap.join(",")}: add a key for a second provider, the panel must be independent`);

  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  const serp: SerpProvider | null = login && password ? dataForSeoProvider(login, password) : null;

  const existing = new Set<string>();
  const goldPath = join(__dirname, "..", "eval/golden/es-peinados.jsonl");
  if (existsSync(goldPath)) {
    for (const line of readFileSync(goldPath, "utf8").split("\n").filter(Boolean)) {
      const g = z.object({ a: z.string(), b: z.string() }).parse(JSON.parse(line));
      existing.add(`${g.a}\u0000${g.b}`).add(`${g.b}\u0000${g.a}`);
    }
  }

  const lines: string[] = [];
  const tally: Record<string, number> = {};
  let id = 1;
  for (const [i, p] of sample.entries()) {
    if (existing.has(`${p.a}\u0000${p.b}`)) continue;
    const a = A.verdicts[i]!;
    const b = B.verdicts[i]!;
    let overlapResult: { common: number } | null = null;
    if (a !== b && serp) {
      const [ra, rb] = await Promise.all([
        serp.search({ keyword: p.a, locationName: "Mexico", languageCode: "es" }),
        serp.search({ keyword: p.b, locationName: "Mexico", languageCode: "es" }),
      ]);
      overlapResult = serpOverlap(ra, rb);
    }
    const r = reconcile(a, b, overlapResult);
    tally[`${r.label}/${r.basis}`] = (tally[`${r.label}/${r.basis}`] ?? 0) + 1;
    lines.push(
      JSON.stringify({
        id: `p${String(id++).padStart(3, "0")}`,
        language: "es",
        locale: "es-MX",
        a: p.a,
        b: p.b,
        label: r.label,
        split: splitFor(p.a, p.b),
        status: r.label === "uncertain" ? "provisional" : "confirmed",
        labeledBy: `llm-panel: ${[...A.models].join("+")} / ${[...B.models].join("+")}${r.basis === "serp" ? " + serp" : ""} (not native-speaker truth)`,
        note: `basis=${r.basis}; A=${a}; B=${b}${overlapResult ? `; serp_common=${overlapResult.common}` : ""}`,
      }),
    );
  }
  writeFileSync(out, lines.join("\n") + "\n");
  console.log(`wrote ${lines.length} pairs to ${out}`);
  console.log("outcome:", tally);
  console.log(`uncertain pairs stay out of the metrics. Review the file, then append it to eval/golden/es-peinados.jsonl (ids must stay unique: rename p### to g###).`);
}
void main();
