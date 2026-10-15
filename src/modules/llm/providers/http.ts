import { z } from "zod";
import { ProviderError, statusIsRetryable } from "../errors";

const errorBodySchema = z.object({ error: z.object({ type: z.string().max(60).optional(), status: z.string().max(60).optional() }).optional() });

/**
 * POSTs JSON and returns the parsed body. Any failure becomes a ProviderError with a short code only:
 * response bodies are never copied into errors or logs (they can echo the prompt).
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<{ json: unknown; requestId: string | null }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
      cache: "no-store",
    });
  } catch (e) {
    const aborted = e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
    throw new ProviderError(aborted ? "timeout" : "network_error", { retryable: true });
  }

  const requestId = res.headers.get("request-id") ?? res.headers.get("x-request-id");

  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      const parsed = errorBodySchema.safeParse(await res.json());
      const t = parsed.success ? (parsed.data.error?.type ?? parsed.data.error?.status) : undefined;
      if (t && /^[a-zA-Z0-9_.-]+$/.test(t)) code = t;
    } catch {
      // keep http_<status>
    }
    throw new ProviderError(code, { status: res.status, retryable: statusIsRetryable(res.status) });
  }

  try {
    return { json: (await res.json()) as unknown, requestId };
  } catch {
    throw new ProviderError("invalid_response", { status: res.status, retryable: true });
  }
}
