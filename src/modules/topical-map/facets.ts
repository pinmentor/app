import { z } from "zod";
import type { Locale } from "./lexicon";
import { candidateSchema, type Candidate } from "./schemas";

/** S1: the topic's dimensions. Expansion goes facet by facet, never "give me 500 keywords" in one call. */
export const facetModelSchema = z.object({
  facets: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        kind: z.enum(["audience", "hair_type", "length", "occasion", "technique", "style", "accessory", "tool", "face_shape", "time", "problem", "other"]),
        values: z.array(z.string().min(1).max(60)).min(2).max(30),
      }),
    )
    .min(3)
    .max(20),
});
export type FacetModel = z.infer<typeof facetModelSchema>;

const LANG_NAME: Record<Locale, string> = { "es-MX": "Mexican Spanish", "es-US": "US Spanish", "es-ES": "Castilian Spanish", "en-US": "US English" };

export function facetPrompt(topic: string, locale: Locale): { system: string; prompt: string } {
  return {
    system: `You build the facet taxonomy of a content topic for a ${LANG_NAME[locale]} blog. A facet is one dimension readers search along (audience, occasion, technique, tool, face shape, problem...). Values are in ${LANG_NAME[locale]}, lowercase, the way people actually type them. Return only JSON: {"facets":[{"name":"","kind":"","values":[""]}]}`,
    prompt: `Topic: ${topic}\nLocale: ${locale}\nList 8-14 facets with 4-20 values each. Include at least one facet of kind "tool" if buying or comparing products is natural for this topic.`,
  };
}

export const keywordListSchema = z.object({ keywords: z.array(z.string().min(2).max(120)).max(120) });

/** S2 source 1: facet value x modifier expansion, one small call per facet value (resumable, <60s each). */
export function expansionPrompt(topic: string, locale: Locale, facetName: string, value: string, n = 40): { system: string; prompt: string } {
  return {
    system: `You list real search queries for a ${LANG_NAME[locale]} audience. One query per entry, lowercase, no numbering, no brand names, no prices. Return only JSON: {"keywords":["..."]}`,
    prompt: `Topic: ${topic}\nFacet: ${facetName} = ${value}\nGive up to ${n} distinct search queries (short and long-tail, how-to and ideas) that combine the topic with this facet value.`,
  };
}

export function questionPrompt(topic: string, locale: Locale, n = 40): { system: string; prompt: string } {
  return {
    system: `You list real question-style search queries (cómo, qué, cuál, por qué, cuánto, cuándo) in ${LANG_NAME[locale]}. Return only JSON: {"keywords":["..."]}`,
    prompt: `Topic: ${topic}\nGive up to ${n} distinct questions people search about this topic.`,
  };
}

/** Clean raw LLM/user strings into candidates: trim, drop empties, excluded terms, over-long phrases, exact repeats. */
export function toCandidates(
  raw: string[],
  meta: { source: string; facet?: string; exclude?: string[] },
): Candidate[] {
  const banned = (meta.exclude ?? []).map((x) => x.toLowerCase());
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const r of raw) {
    const text = r.replace(/\s+/g, " ").trim().replace(/^[-•\d.)\s]+/, "");
    const lower = text.toLowerCase();
    if (!text || text.split(" ").length > 12) continue;
    if (banned.some((b) => lower.includes(b))) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    const c = candidateSchema.safeParse({ raw: text, source: meta.source, facet: meta.facet });
    if (c.success) out.push(c.data);
  }
  return out;
}
