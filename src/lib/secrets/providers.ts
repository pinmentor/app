/**
 * Providers whose platform key can be set from /admin/integrations. The order here is the order on the page.
 * `env` is the fallback: a value in Vercel env vars keeps working when nothing is stored in the admin page.
 */
export const SECRET_PROVIDER_IDS = ["anthropic", "openai", "gemini", "dataforseo"] as const;
export type SecretProviderId = (typeof SECRET_PROVIDER_IDS)[number];

export function isSecretProvider(v: unknown): v is SecretProviderId {
  return typeof v === "string" && (SECRET_PROVIDER_IDS as readonly string[]).includes(v);
}

export type SecretProviderDef = {
  id: SecretProviderId;
  label: string;
  /** What breaks or stays off without it, in plain words. */
  purpose: string;
  /** single = one API key; login_password = two values stored together as one secret. */
  kind: "single" | "login_password";
  env: readonly string[];
  /** Where the owner finds the key. */
  where: string;
};

export const SECRET_PROVIDERS: Record<SecretProviderId, SecretProviderDef> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    purpose: "Claude models: topical maps, titles, articles and language checks.",
    kind: "single",
    env: ["ANTHROPIC_API_KEY"],
    where: "console.anthropic.com, API keys",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    purpose: "GPT models and text embeddings for the duplicate check.",
    kind: "single",
    env: ["OPENAI_API_KEY"],
    where: "platform.openai.com, API keys",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    purpose: "Gemini models (cheap fallback) and embeddings.",
    kind: "single",
    env: ["GEMINI_API_KEY"],
    where: "aistudio.google.com, Get API key",
  },
  dataforseo: {
    id: "dataforseo",
    label: "DataForSEO",
    purpose: "Real Google results for Mexico in Spanish, used to check which keywords want the same page.",
    kind: "login_password",
    env: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
    where: "app.dataforseo.com, API access (login and API password)",
  },
};

/** The value a provider needs, read from env vars. login_password providers become one JSON string, like the stored form. */
export function envSecret(def: SecretProviderDef, env: Record<string, string | undefined>): string | null {
  if (def.kind === "single") {
    const v = env[def.env[0] ?? ""];
    return v && v.length >= 10 ? v : null;
  }
  const login = env[def.env[0] ?? ""];
  const password = env[def.env[1] ?? ""];
  return login && password ? JSON.stringify({ login, password }) : null;
}

export function parseLoginPassword(secret: string): { login: string; password: string } | null {
  try {
    const o = JSON.parse(secret) as unknown;
    if (o && typeof o === "object" && "login" in o && "password" in o && typeof o.login === "string" && typeof o.password === "string") {
      return { login: o.login, password: o.password };
    }
  } catch {
    // fall through
  }
  return null;
}
