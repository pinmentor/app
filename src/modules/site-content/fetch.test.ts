import { describe, expect, it } from "vitest";
import { safeGet } from "./fetch";

const pub = async () => ["93.184.216.34"];
const priv = async () => ["10.0.0.5"];
const res = (status: number, body: string, headers: Record<string, string> = {}) => new Response(body, { status, headers });

describe("safeGet", () => {
  it("reads a page", async () => {
    const r = await safeGet("https://e.com/a", { maxBytes: 1000, timeoutMs: 1000 }, { fetchImpl: async () => res(200, "<html>hola</html>", { "content-type": "text/html" }), resolve: pub });
    expect(r.ok && r.text).toBe("<html>hola</html>");
  });
  it("refuses a host that resolves to a private address", async () => {
    const r = await safeGet("https://e.com/a", { maxBytes: 1000, timeoutMs: 1000 }, { fetchImpl: async () => res(200, "x"), resolve: priv });
    expect(r.ok).toBe(false);
  });
  it("follows a redirect inside the site, refuses one that leaves it", async () => {
    let n = 0;
    const inside = await safeGet("https://e.com/a", { maxBytes: 1000, timeoutMs: 1000 }, { fetchImpl: async () => (n++ === 0 ? res(301, "", { location: "https://www.e.com/b" }) : res(200, "ok")), resolve: pub });
    expect(inside.ok && inside.text).toBe("ok");
    const out = await safeGet("https://e.com/a", { maxBytes: 1000, timeoutMs: 1000 }, { fetchImpl: async () => res(302, "", { location: "https://evil.com/x" }), resolve: pub });
    expect(out.ok).toBe(false);
    const http = await safeGet("https://e.com/a", { maxBytes: 1000, timeoutMs: 1000 }, { fetchImpl: async () => res(302, "", { location: "http://e.com/x" }), resolve: pub });
    expect(http.ok).toBe(false);
  });
  it("stops after 3 redirects", async () => {
    const r = await safeGet("https://e.com/a", { maxBytes: 1000, timeoutMs: 1000 }, { fetchImpl: async () => res(302, "", { location: "https://e.com/loop" }), resolve: pub });
    expect(r.ok).toBe(false);
  });
  it("cuts the body at maxBytes", async () => {
    const r = await safeGet("https://e.com/a", { maxBytes: 10, timeoutMs: 1000 }, { fetchImpl: async () => res(200, "x".repeat(100_000)), resolve: pub });
    expect(r.ok && r.text.length <= 10).toBe(true);
  });
  it("a network error is a short code", async () => {
    const r = await safeGet("https://e.com/a", { maxBytes: 10, timeoutMs: 1000 }, { fetchImpl: async () => { throw new Error("boom secret"); }, resolve: pub });
    expect(r).toEqual({ ok: false, code: "network_error" });
  });
});
