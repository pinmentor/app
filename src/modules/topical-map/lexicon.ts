/**
 * Spanish lexicon for S3/S4. All entries are in FOLDED form (lowercase, no diacritics, singular where the
 * plural rule below produces it). This is a starting point tuned on the dev split of the gold set; it is data,
 * so extending it never needs new logic.
 */

export type Locale = "es-MX" | "es-US" | "es-ES" | "en-US";

/** Dropped from the matching key. NOTE: `sin` is deliberately NOT here (sin plancha != con plancha). */
export const STOPWORDS_ES = new Set([
  "a", "al", "con", "de", "del", "el", "en", "la", "las", "lo", "los", "para", "por", "un", "una", "unos", "unas", "y", "o", "e", "u", "que",
]);

/** Words that do not change which page answers the query. Ignored when comparing keyword content. */
export const GENERIC = new Set(["peinado", "idea", "mejor", "estilo", "tipo", "modelo", "como", "hacer", "forma", "manera", "mas", "top", "ir"]);

/** Canonical form for words that mean the same thing (applied after folding + plural stripping). */
const SYNONYMS_ES: Record<string, string> = {
  pelo: "cabello",
  sencillo: "facil",
  sencilla: "facil",
  simple: "facil",
  rapida: "rapido",
  redonda: "redondo",
  ovalada: "ovalado",
  cuadrada: "cuadrado",
  alargada: "alargado",
  cara: "rostro",
  informal: "casual",
  trabajar: "trabajo",
  xv: "quinceanera",
  quince: "quinceanera",
  rizada: "rizado",
  ondulada: "ondulado",
  lisa: "liso",
  corta: "corto",
  larga: "largo",
  mediana: "mediano",
  fina: "fino",
  gruesa: "grueso",
  alta: "alto",
  baja: "bajo",
  elegantes: "elegante",
  bonita: "bonito",
};

/** Locale-specific extras. `chino` = curly hair in Mexican Spanish; it means something else in other regions. */
const SYNONYMS_BY_LOCALE: Partial<Record<Locale, Record<string, string>>> = {
  "es-MX": { chino: "rizado", china: "rizado" },
};

export function synonymsFor(locale: Locale): Record<string, string> {
  return { ...SYNONYMS_ES, ...(SYNONYMS_BY_LOCALE[locale] ?? {}) };
}

/** Phrase rewrites on the folded string, before tokenising. */
export const PHRASES_ES: [RegExp, string][] = [
  [/\b(xv|quince)\s+anos?\b/g, "quinceanera"],
  [/\bmedia\s+melena\b/g, "mediano"],
  [/\bde\s+moda\b/g, "tendencia"],
];

/**
 * Groups of mutually exclusive modifier values. Two keywords that carry DIFFERENT values of the same group
 * are about different pages (para ninas != para ninos, corto != largo, fino != grueso ...).
 */
export const MODIFIER_GROUPS: Record<string, string[]> = {
  audience: ["nina", "nino", "mujer", "hombre", "adolescente", "novia", "madrina", "bebe", "abuela", "senora", "joven"],
  hairType: ["rizado", "liso", "ondulado", "fino", "grueso", "afro", "tenido", "castano", "rubio", "negro", "pelirrojo"],
  length: ["corto", "mediano", "largo"],
  occasion: ["boda", "graduacion", "quinceanera", "fiesta", "trabajo", "escuela", "playa", "gimnasio", "primaria", "universidad", "bautizo", "cita", "invitada"],
  technique: ["trenza", "recogido", "mono", "coleta", "cola", "semirecogido", "onda", "rulo", "flequillo", "rizo", "chongo", "diadema", "pinza"],
  braidType: ["espiga", "francesa", "holandesa", "cascada", "raiz", "hebra"],
  vibe: ["facil", "rapido", "elegante", "casual", "vintage", "boho", "retro", "moderno", "formal", "clasico", "sexy"],
  face: ["redondo", "ovalado", "cuadrado", "alargado", "triangular", "corazon"],
  season: ["verano", "invierno", "otono", "primavera"],
  height: ["alto", "bajo"],
  tool: ["plancha", "rizador", "secador", "cepillo", "tenaza"],
};
