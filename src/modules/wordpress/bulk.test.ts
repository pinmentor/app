import { describe, expect, it } from "vitest";
import { addDays, planSchedule, validDate } from "./schedule";
import { isRetryableWpCode, sendArticle } from "./send";
import { encryptSitePassword } from "./secret";

const base = { count: 7, startDate: "2026-11-01", perDay: 3, from: "09:00", until: "18:00" };

describe("planSchedule", () => {
  it("N per day inside the window, in order, on consecutive days, last day shorter", () => {
    const r = planSchedule(base);
    expect(r.ok).toBe(true);
    const t = r.ok ? r.times : [];
    expect(t.length).toBe(7);
    expect(t.map((x) => x.slice(0, 10)).join(",")).toBe("2026-11-01,2026-11-01,2026-11-01,2026-11-02,2026-11-02,2026-11-02,2026-11-03");
    expect(t.every((x, i) => i === 0 || x > t[i - 1]!)).toBe(true);
    expect(t.every((x) => x.slice(11) >= "09:00" && x.slice(11) <= "18:00")).toBe(true);
    expect(t.every((x) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(x))).toBe(true);
  });
  it("same input, same plan; times on a day are well apart", () => {
    const a = planSchedule(base), b = planSchedule(base);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const t = a.ok ? a.times : [];
    const m = (x: string) => Number(x.slice(11, 13)) * 60 + Number(x.slice(14, 16));
    expect(m(t[1]!) - m(t[0]!) >= 90).toBe(true);
  });
  it("one per day, month and year rollover, single article", () => {
    const r = planSchedule({ ...base, count: 3, perDay: 1, startDate: "2026-12-30" });
    expect(r.ok && r.times.map((x) => x.slice(0, 10)).join(",")).toBe("2026-12-30,2026-12-31,2027-01-01");
    expect(planSchedule({ ...base, count: 1 }).ok).toBe(true);
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
  it("refuses bad input with a reason", () => {
    const e = (o: object) => { const r = planSchedule({ ...base, ...o }); return r.ok ? "ok" : r.error; };
    expect(e({ count: 0 })).toBe("count");
    expect(e({ count: 101 })).toBe("count");
    expect(e({ startDate: "2026-02-30" })).toBe("date");
    expect(e({ startDate: "tomorrow" })).toBe("date");
    expect(e({ perDay: 0 })).toBe("per_day");
    expect(e({ perDay: 11 })).toBe("per_day");
    expect(e({ from: "9am" })).toBe("window");
    expect(e({ from: "09:00", until: "09:20", perDay: 3 })).toBe("window_short");
    expect(validDate("2026-11-01")).toBe(true);
    expect(validDate("2026-13-01")).toBe(false);
  });
});

describe("isRetryableWpCode", () => {
  it("network and server errors retry; login and setup errors do not", () => {
    for (const c of ["timeout", "network_error", "dns_failed", "http_500", "http_503", "http_429"]) expect(isRetryableWpCode(c)).toBe(true);
    for (const c of ["bad_login", "no_rest_api", "host_not_public", "http_400", "http_404", "redirect"]) expect(isRetryableWpCode(c)).toBe(false);
  });
});

// a tiny stand-in for the Supabase client: only what sendArticle calls
function fakeSb(opts: { verdict?: string; targetError?: string; wpStatus?: number }) {
  const key = Buffer.alloc(32, 3).toString("base64");
  process.env.ENCRYPTION_KEY = key;
  const calls: string[] = [];
  const ct = encryptSitePassword("11111111-1111-4111-8111-111111111111", "https://blog.example.com", "pw");
  const article = { title: "Un título largo", slug: "un-titulo", body_html: "<h1>T</h1><p>x</p>", meta_description: "m", schema_json: null, workspace_id: "11111111-1111-4111-8111-111111111111", qa: { verdict: opts.verdict ?? "pass" }, locale: "es-MX" };
  const sb = {
    rpc: async (name: string) => {
      calls.push(name);
      if (name === "site_article_target") return opts.targetError ? { data: null, error: { code: opts.targetError } } : { data: [{ site_id: "22222222-2222-4222-8222-222222222222", base_url: "https://blog.example.com", wp_user: "u", ciphertext: ct, wp_post_id: null }], error: null };
      return { data: [], error: null };
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: article, error: null }) }) }) }),
  };
  return { sb: sb as never, calls };
}

describe("sendArticle", () => {
  it("a missing site and a not-ready article are permanent, named failures", async () => {
    const a = await sendArticle(fakeSb({ targetError: "PM004" }).sb, "u", "a", { kind: "draft" });
    expect(a.ok ? "ok" : `${a.code}/${a.retryable}`).toBe("no_site/false");
    const b = await sendArticle(fakeSb({ targetError: "PM003" }).sb, "u", "a", { kind: "draft" });
    expect(b.ok ? "ok" : `${b.code}/${b.retryable}`).toBe("notready/false");
  });
  it("a red article is not published or scheduled, and nothing reaches WordPress", async () => {
    const f = fakeSb({ verdict: "fail" });
    const r = await sendArticle(f.sb, "u", "a", { kind: "publish" });
    expect(r.ok ? "ok" : r.code).toBe("blocked");
    expect(f.calls.join(",")).toBe("site_article_target");
  });
});
