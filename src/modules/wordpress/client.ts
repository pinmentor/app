import { assertPublicHost, SiteUrlError, type Resolver } from "./url";

/**
 * Minimal WordPress REST client (core endpoints only, Application Password over HTTPS). Every call re-checks the host,
 * never follows redirects (a redirect could point inside our network) and has a 20 s limit. Errors are short codes, never the response body.
 */
export type WpSite = { baseUrl: string; user: string; password: string };
export type WpResult<T> = { ok: true; data: T } | { ok: false; code: string };
type Deps = { fetchImpl?: typeof fetch; resolve?: Resolver };

const auth = (s: WpSite) => `Basic ${Buffer.from(`${s.user}:${s.password}`).toString("base64")}`;
const api = (s: WpSite, path: string) => `${s.baseUrl}/wp-json/wp/v2/${path}`;

async function call(s: WpSite, method: "GET" | "POST", path: string, body: unknown, d: Deps): Promise<WpResult<{ status: number; json: unknown }>> {
  try {
    await assertPublicHost(new URL(s.baseUrl).hostname, d.resolve);
    const res = await (d.fetchImpl ?? fetch)(api(s, path), {
      method,
      headers: { Authorization: auth(s), Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    if (res.status >= 300 && res.status < 400) return { ok: false, code: "redirect" };
    let json: unknown = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { ok: true, data: { status: res.status, json } };
  } catch (e) {
    if (e instanceof SiteUrlError) return { ok: false, code: e.code };
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, code: timeout ? "timeout" : "network_error" };
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Is the address a WordPress REST API, does the login work, and may the user write posts? Read-only call. */
export async function testSite(s: WpSite, d: Deps = {}): Promise<{ ok: boolean; code: string }> {
  const r = await call(s, "GET", "users/me?context=edit", null, d);
  if (!r.ok) return { ok: false, code: r.code };
  const { status, json } = r.data;
  if (status === 401 || status === 403) return { ok: false, code: "bad_login" };
  if (status === 404) return { ok: false, code: "no_rest_api" };
  if (status !== 200 || !isObj(json)) return { ok: false, code: `http_${status}` };
  const caps = isObj(json.capabilities) ? json.capabilities : {};
  return caps.edit_posts === true ? { ok: true, code: "ok" } : { ok: false, code: "cannot_write" };
}

export type DraftInput = { title: string; content: string; slug: string | null; excerpt: string | null };
export type DraftResult = { id: number; editUrl: string; schemaKept: boolean; created: boolean };

/**
 * Creates a draft, or updates the post stored earlier (status is left as it is on update, so a post the user already published is not
 * turned back into a draft). If the stored post no longer exists (404) a new draft is created. `schemaKept` tells whether WordPress
 * kept the JSON-LD script (it strips scripts for users without the unfiltered_html right).
 */
export async function saveDraft(s: WpSite, input: DraftInput, existingId: number | null, d: Deps = {}): Promise<WpResult<DraftResult>> {
  const fields = { title: input.title, content: input.content, ...(input.slug ? { slug: input.slug } : {}), ...(input.excerpt ? { excerpt: input.excerpt } : {}) };
  let created = existingId === null;
  let r = existingId !== null ? await call(s, "POST", `posts/${existingId}`, fields, d) : await call(s, "POST", "posts", { ...fields, status: "draft" }, d);
  if (r.ok && existingId !== null && r.data.status === 404) {
    created = true;
    r = await call(s, "POST", "posts", { ...fields, status: "draft" }, d);
  }
  if (!r.ok) return r;
  const { status, json } = r.data;
  if (status === 401 || status === 403) return { ok: false, code: "bad_login" };
  if (status === 404) return { ok: false, code: "no_rest_api" };
  if (status < 200 || status >= 300 || !isObj(json) || typeof json.id !== "number") return { ok: false, code: `http_${status}` };
  const raw = isObj(json.content) && typeof json.content.raw === "string" ? json.content.raw : "";
  return { ok: true, data: { id: json.id, editUrl: `${s.baseUrl}/wp-admin/post.php?post=${json.id}&action=edit`, schemaKept: !input.content.includes("application/ld+json") || raw.includes("application/ld+json"), created } };
}
