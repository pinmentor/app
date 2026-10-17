import { describe, expect, it } from "vitest";
import { canonicalUrl, dataForSeoProvider, fixtureSerp, serpOverlap, serpVerdict } from "./serp";

describe("serp overlap", () => {
  it("canonicalises urls (www, scheme, tracking, trailing slash)", () => {
    expect(canonicalUrl("https://www.Ejemplo.com/peinados/?utm_source=x#top")).toBe("ejemplo.com/peinados");
    expect(canonicalUrl("not a url")).toBeNull();
  });
  it("counts shared top-N urls and maps them to a verdict (PLAN 3.6)", async () => {
    const s = fixtureSerp({
      a: ["https://x.com/1", "https://y.com/2", "https://z.com/3", "https://w.com/4", "https://v.com/5"],
      b: ["http://www.x.com/1/", "https://y.com/2", "https://z.com/3", "https://w.com/4", "https://q.com/9"],
      c: ["https://x.com/1", "https://other.com/"],
    });
    const q = (k: string) => s.search({ keyword: k, locationName: "Mexico", languageCode: "es" });
    const ab = serpOverlap(await q("a"), await q("b"));
    expect(ab.common).toBe(4);
    expect(serpVerdict(ab.common)).toBe("same");
    expect(serpVerdict(serpOverlap(await q("a"), await q("c")).common)).toBe("different");
    expect(serpVerdict(2)).toBe("related");
  });
});

describe("dataForSeoProvider (fixture only; not verified live)", () => {
  const ok = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it("sends location + language and keeps organic urls only", async () => {
    let sent: { url: string; body: string; auth: string } | undefined;
    const f = (async (url: string, init: RequestInit) => {
      sent = { url, body: String(init.body), auth: String((init.headers as Record<string, string>).Authorization) };
      return new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [{ type: "organic", url: "https://a.com/1" }, { type: "paid", url: "https://ad.com" }, { type: "organic", url: "https://b.com/2" }] }] }] }));
    }) as unknown as typeof fetch;
    const r = await dataForSeoProvider("me", "pw", f).search({ keyword: "peinados", locationName: "Mexico", languageCode: "es" });
    expect(r.urls).toEqual(["https://a.com/1", "https://b.com/2"]);
    expect(sent!.body).toContain('"location_name":"Mexico"');
    expect(sent!.body).toContain('"language_code":"es"');
    expect(sent!.auth).toBe(`Basic ${Buffer.from("me:pw").toString("base64")}`);
  });
  it("throws on http errors and bad bodies", async () => {
    await expect(dataForSeoProvider("a", "b", ok({}, 500)).search({ keyword: "k", locationName: "Mexico", languageCode: "es" })).rejects.toThrow("serp_http_500");
    await expect(dataForSeoProvider("a", "b", ok({ status_code: 40000 })).search({ keyword: "k", locationName: "Mexico", languageCode: "es" })).rejects.toThrow("serp_bad_response");
  });
});
