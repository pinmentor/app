import { createHash } from "node:crypto";

/**
 * Pure readers for the site-content sync (B25): sitemap XML, RSS, a page's head/headings, WordPress REST posts, a pasted URL list.
 * No network here. Everything is defensive: input comes from a stranger's website, so every value is length-capped and
 * anything unexpected is skipped, never thrown.
 */

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d: string) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]{2,5});/gi, (m, n: string) => ENT[n.toLowerCase()] ?? m);
}
function safeChar(cp: number): string {
  return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "";
}
const clean = (s: string, max: number) => decodeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, max);

/** "https://www.Example.com/a/b/?x=1#y" -> "example.com/a/b" (same page whatever the www, scheme, slash, query or case). */
export function urlKey(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = decodeURIComponent(u.pathname).replace(/\/+$/, "").toLowerCase();
    const key = `${host}${path}`;
    return key.length >= 3 && key.length <= 500 ? key : null;
  } catch {
    return null;
  }
}

export const hostKey = (host: string) => host.toLowerCase().replace(/^www\./, "");

/** A page address of the site: https, same host (www ignored), no credentials, no odd port; returns the clean address or null. */
export function acceptUrl(raw: string, siteHost: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  if (hostKey(u.hostname) !== hostKey(siteHost)) return null;
  if (/\.(jpe?g|png|gif|webp|svg|pdf|zip|mp4|mp3|css|js|xml|ico|woff2?)$/i.test(u.pathname)) return null;
  u.hash = "";
  const out = u.toString();
  return out.length <= 500 ? out : null;
}

export type SitemapKind = { kind: "index" | "urlset"; locs: string[] };
export function parseSitemap(xml: string): SitemapKind {
  const kind = /<sitemapindex[\s>]/i.test(xml) ? "index" : "urlset";
  const locs: string[] = [];
  for (const m of xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)) {
    const v = decodeEntities((m[1] ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
    if (v) locs.push(v);
    if (locs.length >= 5000) break;
  }
  return { kind, locs };
}

/** Sub-sitemaps worth reading for posts and pages; taxonomy, user, image and video maps are skipped. */
export function wantedSubSitemap(loc: string): boolean {
  return !/(taxonom|categor|tag|author|user|image|video|news|attachment|product_cat|product_tag)/i.test(loc.split("/").pop() ?? loc);
}

export type DiscoveredItem = { url: string; url_key: string; title?: string; published_at?: string; meta_description?: string; category?: string };

export function parseRss(xml: string, siteHost: string): DiscoveredItem[] {
  const out: DiscoveredItem[] = [];
  for (const m of xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)) {
    const block = m[0];
    const link = (/<link[^>]*>\s*(?:<!\[CDATA\[)?\s*(https?:[^<\s\]]+)/i.exec(block) ?? /<link[^>]*href="([^"]+)"/i.exec(block))?.[1];
    const url = link ? acceptUrl(decodeEntities(link), siteHost) : null;
    const key = url ? urlKey(url) : null;
    if (!url || !key) continue;
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(block)?.[1];
    const desc = /<description[^>]*>([\s\S]*?)<\/description>/i.exec(block)?.[1] ?? /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(block)?.[1];
    const date = /<(?:pubDate|published|updated)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/i.exec(block)?.[1];
    const cat = /<category[^>]*>([\s\S]*?)<\/category>/i.exec(block)?.[1];
    const item: DiscoveredItem = { url, url_key: key };
    if (title) item.title = clean(title, 300);
    if (desc) item.meta_description = clean(desc, 500);
    const iso = date ? toIso(clean(date, 60)) : null;
    if (iso) item.published_at = iso;
    if (cat) item.category = clean(cat, 120);
    out.push(item);
    if (out.length >= 200) break;
  }
  return out;
}

export function toIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  const y = new Date(t).getUTCFullYear();
  return y >= 1995 && y <= 2100 ? new Date(t).toISOString() : null;
}

/** WordPress REST /wp/v2/posts (public fields): link, date_gmt, title.rendered, excerpt.rendered. */
export function parseWpPosts(json: unknown, siteHost: string): DiscoveredItem[] {
  if (!Array.isArray(json)) return [];
  const out: DiscoveredItem[] = [];
  for (const p of json) {
    if (typeof p !== "object" || p === null) continue;
    const r = p as Record<string, unknown>;
    const url = typeof r.link === "string" ? acceptUrl(r.link, siteHost) : null;
    const key = url ? urlKey(url) : null;
    if (!url || !key) continue;
    const rendered = (v: unknown) => (typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).rendered === "string" ? ((v as Record<string, unknown>).rendered as string) : "");
    const item: DiscoveredItem = { url, url_key: key };
    const title = clean(rendered(r.title), 300);
    if (title) item.title = title;
    const meta = clean(rendered(r.excerpt), 500);
    if (meta) item.meta_description = meta;
    const iso = toIso(typeof r.date_gmt === "string" ? `${r.date_gmt}Z` : typeof r.date === "string" ? r.date : null);
    if (iso) item.published_at = iso;
    out.push(item);
  }
  return out;
}

/** Pasted text or a CSV column: every https address of the site, once each (max 500); the rest is counted as rejected. */
export function parseUrlList(text: string, siteHost: string): { urls: string[]; rejected: number } {
  const seen = new Set<string>();
  const urls: string[] = [];
  let rejected = 0;
  for (const raw of text.split(/[\s,;]+/)) {
    const t = raw.trim().replace(/^["']|["']$/g, "");
    if (!t) continue;
    const u = acceptUrl(t, siteHost);
    const k = u ? urlKey(u) : null;
    if (!u || !k) { rejected++; continue; }
    if (seen.has(k)) continue;
    seen.add(k);
    urls.push(u);
    if (urls.length >= 500) break;
  }
  return { urls, rejected };
}

export type PageData = {
  ok: boolean; title: string | null; h1: string | null; headings: string[]; meta_description: string | null;
  published_at: string | null; word_count: number | null; image_urls: string[]; content_hash: string;
};

/** Reads one HTML page (already size-capped by the fetcher). Headings and meta only; the body text is only counted. */
export function extractPage(html: string, pageUrl: string): PageData {
  const head = html.slice(0, 200_000);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const meta = (name: string) => {
    for (const m of head.matchAll(/<meta\s[^>]*>/gi)) {
      const tag = m[0];
      const n = /(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
      if (n === name) return /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? null;
    }
    return null;
  };
  const body = html.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ");
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1];
  const headings: string[] = [];
  for (const m of body.matchAll(/<h([23])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const t = clean(m[2] ?? "", 200);
    if (t) headings.push(t);
    if (headings.length >= 40) break;
  }
  const text = clean(body.replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, " "), 2_000_000);
  const words = text ? text.split(" ").length : 0;
  const images: string[] = [];
  const og = meta("og:image");
  const add = (src: string | null | undefined) => {
    if (!src) return;
    try {
      const u = new URL(decodeEntities(src), pageUrl);
      if (u.protocol === "https:" && !images.includes(u.toString()) && u.toString().length <= 500) images.push(u.toString());
    } catch { /* skip */ }
  };
  add(og);
  for (const m of body.matchAll(/<img\s[^>]*?src\s*=\s*["']([^"']+)["']/gi)) {
    add(m[1]);
    if (images.length >= 5) break;
  }
  const t = title ? clean(title, 300) : "";
  const h = h1 ? clean(h1, 300) : "";
  const d = meta("description") ?? meta("og:description");
  const md = d ? clean(d, 500) : "";
  const pub = toIso(meta("article:published_time") ?? /<time[^>]*datetime\s*=\s*["']([^"']+)["']/i.exec(body)?.[1]);
  const ok = t !== "" || h !== "";
  return {
    ok, title: t || null, h1: h || null, headings, meta_description: md || null, published_at: pub, word_count: ok ? words : null, image_urls: images.slice(0, 5),
    content_hash: createHash("sha1").update([t, h, ...headings, md].join("\n")).digest("hex"),
  };
}
