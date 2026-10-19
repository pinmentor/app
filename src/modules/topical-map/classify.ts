import { z } from "zod";
import type { Locale } from "./lexicon";
import { tolerantList } from "./tolerant";

/**
 * S5: intent, funnel stage, article type (PLAN §3.8). The LLM judges; cheap rules only cross-check it, so a keyword the
 * two disagree about is flagged `mixed_intent` instead of silently trusting one side.
 */

export const INTENTS = ["informational", "commercial_investigation", "transactional", "navigational"] as const;
export const FUNNELS = ["awareness", "consideration", "decision"] as const;
export type Intent = (typeof INTENTS)[number];
export type Funnel = (typeof FUNNELS)[number];

const pick = <T extends string>(allowed: readonly T[], v: string, fallback: T): T => {
  const x = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (allowed as readonly string[]).includes(x) ? (x as T) : fallback;
};

const clampInt = (lo: number, hi: number, fallback: number) => (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
};

/** Tolerant like the facet schema: an odd label is cleaned (unknown intent -> informational + flagged), never a rejected answer. */
export const classifyItemSchema = z.object({
  i: z.coerce.number().int().min(0),
  intent: z.unknown().transform((v) => (typeof v === "string" ? v : "informational")),
  funnel: z.unknown().transform((v) => (typeof v === "string" ? v : "awareness")),
  demand: z.unknown().optional(),
  pinterest_fit: z.unknown().optional(),
  seasonality: z.unknown().optional(),
  mixed: z.unknown().transform((v) => v === true || v === "true"),
});
export const classifyResponseSchema = tolerantList(classifyItemSchema);

export type Classified = {
  intent: Intent;
  funnel: Funnel;
  demandTier: number;
  pinterestFit: number;
  seasonality: number;
  mixed: boolean;
  /** the model's label was not one of the allowed ones */
  unknownLabel: boolean;
};

export function cleanClassification(r: z.output<typeof classifyItemSchema>): Classified {
  const intent = pick(INTENTS, r.intent, "informational");
  const unknownIntent = !(INTENTS as readonly string[]).includes(r.intent.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  return {
    intent,
    funnel: pick(FUNNELS, r.funnel, "awareness"),
    demandTier: clampInt(1, 5, 3)(r.demand),
    pinterestFit: clampInt(1, 5, 3)(r.pinterest_fit),
    seasonality: clampInt(0, 2, 0)(r.seasonality),
    mixed: r.mixed,
    unknownLabel: unknownIntent,
  };
}

const LANG: Record<Locale, string> = { "es-MX": "Mexican Spanish", "es-US": "US Spanish", "es-ES": "Castilian Spanish", "en-US": "US English" };

export function classifyPrompt(topic: string, locale: Locale, keywords: string[]): { system: string; prompt: string } {
  return {
    system: `You classify ${LANG[locale]} search keywords for a content planner. For each keyword return:
- intent: one of ${INTENTS.join(" | ")}. ONE primary intent. "Ideas / looks / estilos / how to" lists are informational. Comparing or choosing products is commercial_investigation. Buying words (comprar, precio, oferta) are transactional.
- funnel: one of ${FUNNELS.join(" | ")}.
- demand: 1-5, your rough estimate of how many people search it (5 = very popular). This is an estimate, not a search volume.
- pinterest_fit: 1-5, how visual and pin-worthy the topic is (5 = great photos).
- seasonality: 0 = year-round, 1 = mild seasonal, 2 = strongly seasonal (weddings, holidays, back to school).
- mixed: true only when the keyword clearly carries two different intents.
Return only JSON: [{"i":0,"intent":"","funnel":"","demand":3,"pinterest_fit":3,"seasonality":0,"mixed":false}], one object per keyword, same order.`,
    prompt: `Topic: ${topic}\n${keywords.map((k, i) => `${i}. ${k}`).join("\n")}`,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Cheap rule cross-checks (heuristic, es + en). They never decide; they only raise flags.
// ---------------------------------------------------------------------------------------------------------------------
const BUY = /\b(comprar|compra|precio|precios|barato|baratos|barata|baratas|oferta|ofertas|descuento|descuentos|cu[aá]nto cuesta|d[oó]nde comprar|buy|price|cheap|discount|deal|deals)\b/i;
const PRICE = /\b(precio|precios|barato|baratos|barata|baratas|oferta|ofertas|descuento|descuentos|cu[aá]nto cuesta|cuanto cuesta|price|prices|cheap|discount|how much)\b/i;
const COMPARE = /\b(vs|versus|comparativa|comparaci[oó]n|alternativas?|opiniones|rese[ñn]as?|review|reviews|mejor(es)? (plancha|secador|rizador|cepillo|shampoo|champ[uú]|tinte|producto)s?)\b/i;

/** What the words alone suggest; null = no strong signal. */
export function ruleIntent(raw: string): Intent | null {
  if (BUY.test(raw)) return "transactional";
  if (COMPARE.test(raw)) return "commercial_investigation";
  return null;
}

/** Price words: the plan forbids prices in articles (CLAUDE.md), so the editor should look at these items. */
export function mentionsPrice(raw: string): boolean {
  return PRICE.test(raw);
}

/** Type B = commercial (PLAN §3.8), Type A = ideas / looks / lists. Navigational has no article of its own: A, flagged elsewhere. */
export function articleTypeFor(intent: Intent): "A" | "B" {
  return intent === "commercial_investigation" || intent === "transactional" ? "B" : "A";
}

/** Final flags of one keyword from the model's answer and the rules. */
export function classificationFlags(raw: string, c: Classified): string[] {
  const flags: string[] = [];
  const rule = ruleIntent(raw);
  const ruleSaysCommercial = rule === "transactional" || rule === "commercial_investigation";
  const modelSaysCommercial = c.intent === "transactional" || c.intent === "commercial_investigation";
  if (c.mixed || (ruleSaysCommercial && !modelSaysCommercial)) flags.push("mixed_intent");
  if (c.unknownLabel) flags.push("intent_label_unknown");
  if (c.intent === "navigational") flags.push("navigational");
  if (mentionsPrice(raw)) flags.push("price_words");
  return flags;
}
