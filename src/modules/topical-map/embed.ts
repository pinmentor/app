import { normalize } from "./normalize";
import type { Locale } from "./lexicon";

export type Embedder = {
  /** Identifies the embedding space: cosine thresholds are only valid for the embedder they were tuned on. */
  id: string;
  embed(texts: string[]): Promise<number[][]>;
};

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Offline, deterministic baseline: hashed character trigrams of the canonical text. It knows spelling, not
 * meaning, so it is a floor for the eval and a test double, never the production embedder.
 */
export function lexicalEmbedder(locale: Locale = "es-MX", dim = 512): Embedder {
  return {
    id: `lexical-trigram-${dim}`,
    async embed(texts) {
      return texts.map((t) => {
        const v = new Array<number>(dim).fill(0);
        const text = ` ${normalize(t, locale).tokens.join(" ")} `;
        for (let i = 0; i + 3 <= text.length; i++) v[hash(text.slice(i, i + 3)) % dim]! += 1;
        return v;
      });
    },
  };
}
