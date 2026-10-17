import { MODIFIER_GROUPS } from "./lexicon";
import type { Normalized } from "./normalize";

const VALUE_TO_GROUP = new Map<string, string>();
for (const [group, values] of Object.entries(MODIFIER_GROUPS)) for (const v of values) VALUE_TO_GROUP.set(v, group);

export type Facts = {
  /** group -> set of values present */
  groups: Map<string, Set<string>>;
  /** numbers, e.g. "n:30" for a list size, "t:5" for 5 minutos */
  numbers: Set<string>;
  /** "con:plancha" / "sin:plancha" */
  polarity: Set<string>;
};

export function extractFacts(n: Normalized): Facts {
  const groups = new Map<string, Set<string>>();
  for (const t of n.tokens) {
    const g = VALUE_TO_GROUP.get(t);
    if (!g) continue;
    if (!groups.has(g)) groups.set(g, new Set());
    groups.get(g)!.add(t);
  }
  const numbers = new Set<string>();
  const polarity = new Set<string>();
  const toks = n.rawTokens;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (/^\d+$/.test(t)) {
      const unit = toks[i + 1];
      numbers.add(unit === "minuto" || unit === "min" ? `t:${t}` : unit === "ano" ? `y:${t}` : `n:${t}`);
    }
    if (t === "con" || t === "sin") {
      // the next non-stopword token is what the polarity applies to
      for (let j = i + 1; j < toks.length; j++) {
        const nxt = toks[j]!;
        if (["el", "la", "los", "las", "un", "una", "de"].includes(nxt)) continue;
        polarity.add(`${t}:${nxt}`);
        break;
      }
    }
  }
  return { groups, numbers, polarity };
}

/** Why two keywords cannot be the same page, or null if no hard conflict. */
export function conflict(a: Facts, b: Facts): string | null {
  for (const [g, av] of a.groups) {
    const bv = b.groups.get(g);
    if (!bv) continue;
    const onlyA = [...av].filter((v) => !bv.has(v));
    const onlyB = [...bv].filter((v) => !av.has(v));
    if (onlyA.length > 0 && onlyB.length > 0) return `${g}: ${onlyA.join("/")} vs ${onlyB.join("/")}`;
  }
  // numbers of the same kind that differ (25 vs 30 articles, 5 vs 10 minutes)
  for (const x of a.numbers) {
    const kind = x.slice(0, 2);
    const others = [...b.numbers].filter((y) => y.startsWith(kind));
    if (others.length > 0 && !b.numbers.has(x)) return `number: ${x} vs ${others.join("/")}`;
  }
  for (const p of a.polarity) {
    const [pol, noun] = p.split(":") as [string, string];
    const opposite = `${pol === "con" ? "sin" : "con"}:${noun}`;
    if (b.polarity.has(opposite)) return `polarity: ${p} vs ${opposite}`;
  }
  return null;
}
