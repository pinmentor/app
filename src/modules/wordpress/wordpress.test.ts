import { describe, expect, it } from "vitest";
import { assertPublicHost, isPrivateIp, normalizeSiteUrl } from "./url";
import { cleanAppPassword, decryptSitePassword, encryptSitePassword } from "./secret";
import { saveDraft, testSite, type WpSite } from "./client";
import { postContent } from "./push";

const KEY = Buffer.alloc(32, 7).toString("base64");
const site: WpSite = { baseUrl: "https://blog.example.com", user: "admin", password: "abcd efgh" };
const pub = async () => ["93.184.216.34"];
const reply = (status: number, json: unknown) => (async () => new Response(JSON.stringify(json), { status })) as unknown as typeof fetch;

describe("normalizeSiteUrl", () => {
  it("accepts https addresses and tidies them", () => {
    expect(normalizeSiteUrl("Blog.Example.com/")).toBe("https://blog.example.com");
    expect(normalizeSiteUrl("https://example.com/blog/")).toBe("https://example.com/blog");
    expect(normalizeSiteUrl("https://example.com:443")).toBe("https://example.com");
  });
  it("refuses http, credentials, query, odd ports, IPs, local names", () => {
    for (const bad of ["http://example.com", "https://u:p@example.com", "https://example.com/?a=1", "https://example.com:8443", "https://127.0.0.1", "https://[::1]", "https://localhost", "https://intranet", "https://x.internal", "https://10.0.0.5", "", "not a url"]) {
      expect(normalizeSiteUrl(bad)).toBe(null);
    }
  });
});

describe("isPrivateIp / assertPublicHost", () => {
  it("flags private ranges", () => {
    for (const ip of ["10.1.1.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "224.0.0.1"]) expect(isPrivateIp(ip)).toBe(true);
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1"]) expect(isPrivateIp(ip)).toBe(false);
  });
  it("refuses a name that resolves to a private address, even one of several", async () => {
    await assertPublicHost("a.example.com", pub);
    let code = "";
    try { await assertPublicHost("evil.example.com", async () => ["93.184.216.34", "10.0.0.1"]); } catch (e) { code = (e as Error).message; }
    expect(code).toBe("host_not_public");
    try { await assertPublicHost("nx.example.com", async () => { throw new Error("x"); }); } catch (e) { code = (e as Error).message; }
    expect(code).toBe("dns_failed");
  });
});

describe("site password encryption", () => {
  it("round-trips and is bound to workspace and address", () => {
    const blob = encryptSitePassword("w1", "https://a.example.com", "secret pw", KEY);
    expect(blob.startsWith("v1.")).toBe(true);
    expect(blob.includes("secret")).toBe(false);
    expect(decryptSitePassword("w1", "https://a.example.com", blob, KEY)).toBe("secret pw");
    let bad = 0;
    for (const [w, u] of [["w2", "https://a.example.com"], ["w1", "https://b.example.com"]] as const) {
      try { decryptSitePassword(w, u, blob, KEY); } catch { bad++; }
    }
    expect(bad).toBe(2);
    expect(cleanAppPassword("abcd efgh\nijkl")).toBe("abcdefghijkl");
  });
});

describe("testSite", () => {
  it("maps WordPress answers to short codes", async () => {
    expect((await testSite(site, { fetchImpl: reply(200, { capabilities: { edit_posts: true } }), resolve: pub })).code).toBe("ok");
    expect((await testSite(site, { fetchImpl: reply(200, { capabilities: { edit_posts: false } }), resolve: pub })).code).toBe("cannot_write");
    expect((await testSite(site, { fetchImpl: reply(401, {}), resolve: pub })).code).toBe("bad_login");
    expect((await testSite(site, { fetchImpl: reply(404, {}), resolve: pub })).code).toBe("no_rest_api");
    expect((await testSite(site, { fetchImpl: reply(500, {}), resolve: pub })).code).toBe("http_500");
    expect((await testSite(site, { fetchImpl: reply(200, {}), resolve: async () => ["10.0.0.1"] })).code).toBe("host_not_public");
  });
  it("does not follow redirects and reports network failure", async () => {
    expect((await testSite(site, { fetchImpl: reply(302, {}), resolve: pub })).code).toBe("redirect");
    const boom = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect((await testSite(site, { fetchImpl: boom, resolve: pub })).code).toBe("network_error");
  });
});

describe("saveDraft", () => {
  const input = { title: "T", content: "<p>x</p>", slug: "t", excerpt: "e" };
  it("creates a draft and returns the edit link", async () => {
    let seen: { url: string; body: Record<string, unknown> } | null = null;
    const f = (async (url: string, init: RequestInit) => { seen = { url, body: JSON.parse(String(init.body)) }; return new Response(JSON.stringify({ id: 42, content: { raw: "<p>x</p>" } }), { status: 201 }); }) as unknown as typeof fetch;
    const r = await saveDraft(site, input, null, { fetchImpl: f, resolve: pub });
    expect(r.ok && r.data.id).toBe(42);
    expect(r.ok && r.data.editUrl).toBe("https://blog.example.com/wp-admin/post.php?post=42&action=edit");
    expect(seen!.url).toBe("https://blog.example.com/wp-json/wp/v2/posts");
    expect(seen!.body.status).toBe("draft");
  });
  it("updates the stored post without touching its status; a missing post becomes a new draft", async () => {
    const urls: string[] = []; const bodies: Record<string, unknown>[] = [];
    const f = (async (url: string, init: RequestInit) => { urls.push(url); bodies.push(JSON.parse(String(init.body))); return urls.length === 1 ? new Response("{}", { status: 404 }) : new Response(JSON.stringify({ id: 77, content: { raw: "" } }), { status: 201 }); }) as unknown as typeof fetch;
    const r = await saveDraft(site, input, 5, { fetchImpl: f, resolve: pub });
    expect(urls.join(",")).toBe("https://blog.example.com/wp-json/wp/v2/posts/5,https://blog.example.com/wp-json/wp/v2/posts");
    expect("status" in bodies[0]!).toBe(false);
    expect(bodies[1]!.status).toBe("draft");
    expect(r.ok && r.data.created).toBe(true);
  });
  it("reports when WordPress stripped the JSON-LD script, and bad logins", async () => {
    const withSchema = { ...input, content: `<p>x</p><script type="application/ld+json">{}</script>` };
    const kept = await saveDraft(site, withSchema, null, { fetchImpl: reply(201, { id: 1, content: { raw: withSchema.content } }), resolve: pub });
    const stripped = await saveDraft(site, withSchema, null, { fetchImpl: reply(201, { id: 1, content: { raw: "<p>x</p>" } }), resolve: pub });
    expect(kept.ok && kept.data.schemaKept).toBe(true);
    expect(stripped.ok && stripped.data.schemaKept).toBe(false);
    const bad = await saveDraft(site, input, null, { fetchImpl: reply(401, {}), resolve: pub });
    expect(bad.ok ? "ok" : bad.code).toBe("bad_login");
  });
});

describe("postContent", () => {
  it("drops the h1, appends escaped JSON-LD, and leaves content alone without schema", () => {
    const out = postContent("<h1>Title</h1>\n\n<h2>A</h2>", [{ "@type": "Article", headline: "</script><b>" }]);
    expect(out.startsWith("<h2>A</h2>")).toBe(true);
    expect(out.includes("<h1>")).toBe(false);
    expect(out.includes("</script><b>")).toBe(false);
    expect(out.includes("\\u003c/script>")).toBe(true);
    expect(postContent("<h1>T</h1><p>x</p>", null)).toBe("<p>x</p>");
  });
});
