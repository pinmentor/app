import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

/**
 * The site address a user types is the one place where the server is told to call an arbitrary host, so it is checked hard
 * (SSRF guard): https only, no credentials, no port other than 443, no IP literal, and every address the name resolves to must be
 * public. Nothing here proves the site is WordPress; the connection test does that.
 */
export function normalizeSiteUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim().includes("://") ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null;
  if (u.port && u.port !== "443") return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || isIP(host.replace(/^\[|\]$/g, "")) !== 0 || /[^a-z0-9.-]/.test(host) || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) return null;
  const path = u.pathname.replace(/\/+$/, "");
  if (/[\s]/.test(path)) return null;
  const out = `https://${host}${path}`;
  return out.length <= 200 ? out : null;
}

/** True for loopback, private, link-local, CGNAT, multicast, unspecified and IPv4-mapped versions of those. */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0);
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]!);
    return x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff");
  }
  return true; // not an IP at all: refuse
}

export type Resolver = (host: string) => Promise<string[]>;
const systemResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((r) => r.address);

export class SiteUrlError extends Error {
  constructor(public readonly code: "host_not_public" | "dns_failed") {
    super(code);
    this.name = "SiteUrlError";
  }
}

/** Throws unless the host resolves, and only to public addresses. (A DNS rebind between this check and the request is a known residual risk of any check-then-fetch.) */
export async function assertPublicHost(host: string, resolve: Resolver = systemResolver): Promise<void> {
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch {
    throw new SiteUrlError("dns_failed");
  }
  if (addrs.length === 0 || addrs.some(isPrivateIp)) throw new SiteUrlError("host_not_public");
}
