import { assertPublicHost, SiteUrlError, type Resolver } from "@/modules/wordpress/url";
import { hostKey } from "./parse";

/**
 * The one door the content sync uses to read a website. SSRF guard on every hop: https only, the host must resolve to public
 * addresses only, redirects are followed by hand (max 3) and only to the same site. The body is read in a stream and cut at
 * maxBytes (a huge page never fills memory); there is a timeout per request. Errors are short codes, never the body.
 */
export type Fetched = { ok: true; status: number; contentType: string; text: string; headers: Headers } | { ok: false; code: string };
type Deps = { fetchImpl?: typeof fetch; resolve?: Resolver };
type Opts = { maxBytes: number; timeoutMs: number; accept?: string };

const UA = "PinMentorBot/1.0 (site content sync; reads titles and headings only)";

export async function safeGet(url: string, o: Opts, d: Deps = {}): Promise<Fetched> {
  let current = url;
  const origin = new URL(url).hostname;
  try {
    for (let hop = 0; hop < 4; hop++) {
      const u = new URL(current);
      if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443") || hostKey(u.hostname) !== hostKey(origin)) return { ok: false, code: "bad_redirect" };
      await assertPublicHost(u.hostname, d.resolve);
      const res = await (d.fetchImpl ?? fetch)(current, {
        method: "GET",
        headers: { "User-Agent": UA, Accept: o.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5" },
        redirect: "manual",
        signal: AbortSignal.timeout(o.timeoutMs),
        cache: "no-store",
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return { ok: false, code: "redirect" };
        current = new URL(loc, current).toString();
        continue;
      }
      return { ok: true, status: res.status, contentType: (res.headers.get("content-type") ?? "").toLowerCase(), text: await readCapped(res, o.maxBytes), headers: res.headers };
    }
    return { ok: false, code: "too_many_redirects" };
  } catch (e) {
    if (e instanceof SiteUrlError) return { ok: false, code: e.code };
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, code: timeout ? "timeout" : "network_error" };
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, max);
  const reader = res.body.getReader();
  const dec = new TextDecoder("utf-8", { fatal: false });
  let out = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    out += dec.decode(value, { stream: true });
    if (bytes >= max) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return out.slice(0, max);
}
