import { z } from "zod";
import { JobError, type JobContext, type JobHandler } from "@/modules/jobs/types";
import { db, parsePayload, rpc, uuid } from "@/modules/topical-map/stage-kit";
import { safeGet } from "./fetch";
import { acceptUrl, extractPage, parseRss, parseSitemap, parseUrlList, parseWpPosts, urlKey, wantedSubSitemap, type DiscoveredItem } from "./parse";

/**
 * `site.sync`: reads what a website already has into site_contents (headings and meta only). Chunked and resumable: every step
 * is well under 60 s and enqueues its successor with the state in the payload; the rows themselves are the other half of the state
 * (a row without fetched_at is a page still to read), so a retried step repeats nothing harmful.
 *   discover: WordPress REST (public posts and pages, titles come with it) -> else sitemap(s) -> else RSS; or the pasted list
 *   fetch:    reads up to PAGES_PER_STEP pending pages (title, h1, h2/h3, meta, date, images)
 *   finish:   removes rows of the discovered sources the site no longer lists, marks the sync done
 */
const MAX_ATTEMPTS = 3; // must match site_content_sync_start (0030)
const WP_PAGES_PER_STEP = 3;
const SITEMAPS_PER_STEP = 4;
const PAGES_PER_STEP = 10;
const PAGE_CONCURRENCY = 5;
const MAX_ROWS = 3000;
const MAX_SITEMAPS = 30;

const payload = z.object({
  siteId: uuid,
  userId: uuid,
  mode: z.enum(["auto", "urls"]),
  step: z.enum(["discover", "fetch"]),
  startedAt: z.string(),
  seq: z.number().int().min(0).default(0),
  phase: z.enum(["wp_posts", "wp_pages", "sitemap", "rss"]).default("wp_posts"),
  page: z.number().int().min(1).default(1),
  found: z.number().int().min(0).default(0), // addresses found so far in this sync (decides the fallbacks)
  maps: z.array(z.string()).max(MAX_SITEMAPS).optional(), // sitemap files still to read
  urls: z.array(z.string()).max(500).nullish(), // the pasted list (first step of mode "urls")
});
type P = z.infer<typeof payload>;

const siteRow = z.object({ id: uuid, workspace_id: uuid, base_url: z.string() });

async function loadSite(ctx: JobContext, siteId: string) {
  const { data, error } = await db().from("sites").select("id, workspace_id, base_url").eq("id", siteId).eq("workspace_id", ctx.workspaceId).maybeSingle();
  if (error) throw new JobError("site lookup failed", "db_error", { retryable: true });
  const s = siteRow.safeParse(data);
  if (!s.success) throw new JobError("site not found", "site_not_found", { retryable: false });
  return s.data;
}

async function next(ctx: JobContext, p: P, patch: Partial<P>, delay = 1): Promise<void> {
  const n: P = { ...p, ...patch, seq: p.seq + 1 };
  await rpc("job_enqueue", {
    p_workspace: ctx.workspaceId, p_type: "site.sync", p_payload: { ...n, urls: null }, p_key: `site.sync:${p.siteId}:${Date.parse(p.startedAt)}:${n.seq}`,
    p_credit_action: null, p_run_at: new Date(Date.now() + delay * 1000).toISOString(), p_max_attempts: MAX_ATTEMPTS, p_priority: 0, p_provider: null, p_parent: ctx.jobId, p_stage: n.step,
  });
}

async function rowCount(siteId: string): Promise<number> {
  const r = await db().from("site_contents").select("id", { count: "exact", head: true }).eq("site_id", siteId);
  return r.count ?? 0;
}

async function discover(siteId: string, source: "sitemap" | "rss" | "wp" | "manual", items: DiscoveredItem[]): Promise<number> {
  if (items.length === 0) return 0;
  const room = Math.max(0, MAX_ROWS - (await rowCount(siteId)));
  const take = items.slice(0, room);
  let n = 0;
  for (let i = 0; i < take.length; i += 500) n += z.coerce.number().parse(await rpc("site_content_discover", { p_site: siteId, p_source: source, p_items: take.slice(i, i + 500) }));
  return n;
}

const asItems = (urls: string[], host: string): DiscoveredItem[] =>
  urls.flatMap((u) => {
    const url = acceptUrl(u, host);
    const key = url ? urlKey(url) : null;
    return url && key ? [{ url, url_key: key }] : [];
  });

async function discoverStep(ctx: JobContext, p: P, site: z.infer<typeof siteRow>): Promise<Record<string, unknown>> {
  const base = site.base_url.replace(/\/+$/, "");
  const origin = new URL(base).origin;
  const host = new URL(base).hostname;

  if (p.mode === "urls") {
    const { urls } = parseUrlList((p.urls ?? []).join("\n"), host);
    const n = await discover(site.id, "manual", asItems(urls, host));
    await rpc("site_content_progress", { p_site: site.id, p_state: "running" });
    await next(ctx, p, { step: "fetch", found: n });
    return { discovered: n };
  }

  if (p.phase === "wp_posts" || p.phase === "wp_pages") {
    const kind = p.phase === "wp_posts" ? "posts" : "pages";
    let found = p.found;
    let page = p.page;
    let totalPages = Infinity;
    for (let i = 0; i < WP_PAGES_PER_STEP && page <= totalPages && page <= 10; i++, page++) {
      const r = await safeGet(`${base}/wp-json/wp/v2/${kind}?per_page=100&page=${page}&_fields=link,title,date_gmt,excerpt`, { maxBytes: 1_500_000, timeoutMs: 15_000, accept: "application/json" });
      if (!r.ok || r.status !== 200 || !r.contentType.includes("json")) { totalPages = page - 1; break; }
      let json: unknown = null;
      try { json = JSON.parse(r.text); } catch { totalPages = page - 1; break; }
      const items = parseWpPosts(json, host);
      found += await discover(site.id, "wp", items);
      const tp = Number(r.headers.get("x-wp-totalpages"));
      totalPages = Number.isFinite(tp) && tp > 0 ? tp : items.length < 100 ? page : Infinity;
      if (items.length === 0) break;
    }
    const more = page <= totalPages && page <= 10;
    await rpc("site_content_progress", { p_site: site.id, p_state: "running" });
    if (more) await next(ctx, p, { page, found });
    else if (p.phase === "wp_posts") await next(ctx, p, { phase: "wp_pages", page: 1, found });
    else if (found > 0) await next(ctx, p, { step: "fetch", found });
    else await next(ctx, p, { phase: "sitemap", page: 1, found, maps: undefined });
    return { phase: p.phase, found };
  }

  if (p.phase === "sitemap") {
    let maps = p.maps;
    let found = p.found;
    if (!maps) {
      // first step of the phase: find the sitemap file
      for (const path of ["/wp-sitemap.xml", "/sitemap_index.xml", "/sitemap.xml"]) {
        const r = await safeGet(`${origin}${path}`, { maxBytes: 3_000_000, timeoutMs: 10_000, accept: "application/xml,text/xml,*/*;q=0.5" });
        if (!r.ok || r.status !== 200) continue;
        const sm = parseSitemap(r.text);
        if (sm.locs.length === 0) continue;
        if (sm.kind === "urlset") found += await discover(site.id, "sitemap", asItems(sm.locs, host));
        else maps = sm.locs.filter((l) => wantedSubSitemap(l) && acceptUrl(l, host)).slice(0, MAX_SITEMAPS);
        break;
      }
      if (!maps && found === p.found) { await next(ctx, p, { phase: "rss" }); return { phase: "sitemap", found: 0 }; }
      maps ??= [];
    } else {
      const todo = maps.slice(0, SITEMAPS_PER_STEP);
      maps = maps.slice(SITEMAPS_PER_STEP);
      for (const loc of todo) {
        const r = await safeGet(loc, { maxBytes: 3_000_000, timeoutMs: 10_000, accept: "application/xml,text/xml,*/*;q=0.5" });
        if (!r.ok || r.status !== 200) continue;
        const sm = parseSitemap(r.text);
        if (sm.kind === "urlset") found += await discover(site.id, "sitemap", asItems(sm.locs, host));
      }
    }
    await rpc("site_content_progress", { p_site: site.id, p_state: "running" });
    if (maps.length > 0) await next(ctx, p, { maps, found });
    else await next(ctx, p, { step: "fetch", found, maps: undefined });
    return { phase: "sitemap", found };
  }

  // rss: last resort, the latest items of the feed (titles come with it)
  let found = p.found;
  for (const path of ["/feed/", "/feed", "/rss.xml"]) {
    const r = await safeGet(`${origin}${path}`, { maxBytes: 1_500_000, timeoutMs: 10_000, accept: "application/rss+xml,application/xml,text/xml,*/*;q=0.5" });
    if (!r.ok || r.status !== 200) continue;
    const items = parseRss(r.text, host);
    if (items.length === 0) continue;
    found += await discover(site.id, "rss", items);
    break;
  }
  if (found === 0) throw new JobError("nothing found", "nothing_found", { retryable: false });
  await next(ctx, p, { step: "fetch", found });
  return { phase: "rss", found };
}

async function fetchStep(ctx: JobContext, p: P, site: z.infer<typeof siteRow>): Promise<Record<string, unknown>> {
  const pending = await db().from("site_contents").select("url, url_key").eq("site_id", site.id).is("fetched_at", null).order("created_at").order("url_key").limit(PAGES_PER_STEP);
  if (pending.error) throw new JobError("pending read failed", "db_error", { retryable: true });
  const rows = z.array(z.object({ url: z.string(), url_key: z.string() })).parse(pending.data ?? []);
  let read = 0;
  for (let i = 0; i < rows.length; i += PAGE_CONCURRENCY) {
    await Promise.all(
      rows.slice(i, i + PAGE_CONCURRENCY).map(async (row) => {
        const r = await safeGet(row.url, { maxBytes: 400_000, timeoutMs: 8_000 });
        const page = r.ok && r.status === 200 && (r.contentType.includes("html") || r.contentType === "") ? extractPage(r.text, row.url) : null;
        if (page?.ok) read++;
        await rpc("site_content_save_page", { p_site: site.id, p_page: { url_key: row.url_key, ...(page ?? { ok: false, content_hash: "unreadable" }) } });
      }),
    );
  }
  const left = await db().from("site_contents").select("id", { count: "exact", head: true }).eq("site_id", site.id).is("fetched_at", null);
  if (left.error) throw new JobError("pending count failed", "db_error", { retryable: true });
  if ((left.count ?? 0) > 0) {
    await rpc("site_content_progress", { p_site: site.id, p_state: "running" });
    await next(ctx, p, { step: "fetch" });
    return { read, left: left.count ?? 0 };
  }
  const pruned = p.mode === "auto" && p.found > 0 ? z.coerce.number().parse(await rpc("site_content_prune", { p_site: site.id, p_before: p.startedAt })) : 0;
  await rpc("site_content_progress", { p_site: site.id, p_state: "done" });
  return { read, pruned, done: true };
}

export const siteSyncJob: JobHandler = async (ctx) => {
  const p = parsePayload(payload, ctx.payload);
  try {
    const site = await loadSite(ctx, p.siteId);
    return p.step === "discover" ? await discoverStep(ctx, p, site) : await fetchStep(ctx, p, site);
  } catch (e) {
    const permanent = e instanceof JobError && !e.retryable;
    if (permanent || ctx.attempt >= MAX_ATTEMPTS) {
      const code = e instanceof JobError ? e.code : "unexpected";
      await db().rpc("site_content_progress", { p_site: p.siteId, p_state: "failed", p_error: code.slice(0, 100) });
    }
    throw e;
  }
};

export const siteContentHandlers: Record<string, JobHandler> = { "site.sync": siteSyncJob };
