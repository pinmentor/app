import { judgeResponseSchema } from "./schemas";
import type { Verdict } from "./compare";

export type JudgeInput = { a: string; b: string };
export type JudgeOutput = { verdict: Verdict; reason: string };

/** Layer 2 of S4: decides borderline pairs. Production binds this to callLlm (task `intent_judge`). */
export type IntentJudge = {
  id: string;
  judge(pairs: JudgeInput[]): Promise<JudgeOutput[]>;
};

/** Without a judge, borderline pairs stay `related`: two articles, never a silent merge. */
export const conservativeJudge: IntentJudge = {
  id: "conservative",
  async judge(pairs) {
    return pairs.map(() => ({ verdict: "related" as const, reason: "no judge configured; kept separate" }));
  },
};

export const JUDGE_BATCH = 30;

export const JUDGE_SYSTEM = `You judge Spanish search keywords for a content planner. For each pair decide whether ONE web page could satisfy BOTH search intents.
Answer one of: same | parent_child | related | different.
- same: one page answers both (synonyms, word order, singular/plural, cabello/pelo, sencillos/fáciles).
- parent_child: one is a narrower version of the other (extra audience, occasion, hair type, length, technique).
- related: same topic, but two different pages.
- different: different intent or unrelated.
Modifiers change the intent: para niñas, para niños and para mujeres are different; fáciles is not elegantes; con plancha is not sin plancha; numbers and times (en 5 minutos) matter.
Return only one JSON object of the form {"results":[{"i":0,"verdict":"same","reason":"short"}]} with one entry per pair, same order.`;

export function buildJudgePrompt(pairs: JudgeInput[]): string {
  return pairs.map((p, i) => `${i}. "${p.a}" | "${p.b}"`).join("\n");
}

/**
 * `callJson` is injected so this stays testable offline. In the app it wraps callLlm({task:"intent_judge", schema})
 * so model ids, prices, fallbacks and cost logging all stay in the registry.
 */
export function llmIntentJudge(
  callJson: (req: { system: string; prompt: string }) => Promise<unknown>,
  id = "llm",
): IntentJudge {
  return {
    id,
    async judge(pairs) {
      const out: JudgeOutput[] = [];
      for (let start = 0; start < pairs.length; start += JUDGE_BATCH) {
        const chunk = pairs.slice(start, start + JUDGE_BATCH);
        const parsed = judgeResponseSchema.safeParse(await callJson({ system: JUDGE_SYSTEM, prompt: buildJudgePrompt(chunk) }));
        const byIndex = new Map(parsed.success ? parsed.data.map((r) => [r.i, r]) : []);
        chunk.forEach((_, i) => {
          const r = byIndex.get(i);
          // Missing or invalid answer: keep separate. Never merge on a failed judgement.
          out.push(r ? { verdict: r.verdict, reason: r.reason } : { verdict: "related", reason: "judge gave no valid answer; kept separate" });
        });
      }
      return out;
    },
  };
}
