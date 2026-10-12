export const LANGUAGES = [
  { code: "es", name: "Español", locale: "es-MX" },
  { code: "en", name: "English", locale: "en-US" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

export function isLanguageCode(v: string): v is LanguageCode {
  return LANGUAGES.some((l) => l.code === v);
}
