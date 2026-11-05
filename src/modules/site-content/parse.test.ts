import { describe, expect, it } from "vitest";
import { acceptUrl, extractPage, parseRss, parseSitemap, parseUrlList, parseWpPosts, urlKey, wantedSubSitemap } from "./parse";

describe("urlKey / acceptUrl", () => {
  it("one page, one key", () => {
    expect(urlKey("https://www.Example.com/Peinados/?x=1#y")).toBe("example.com/peinados");
    expect(urlKey("http://example.com/peinados/")).toBe("example.com/peinados");
    expect(urlKey("ftp://example.com/a")).toBeNull();
  });
  it("accepts only https pages of the same host", () => {
    expect(acceptUrl("https://www.example.com/a/", "example.com")).toBe("https://www.example.com/a/");
    expect(acceptUrl("http://example.com/a", "example.com")).toBeNull();
    expect(acceptUrl("https://evil.com/a", "example.com")).toBeNull();
    expect(acceptUrl("https://user:pw@example.com/a", "example.com")).toBeNull();
    expect(acceptUrl("https://example.com:8443/a", "example.com")).toBeNull();
    expect(acceptUrl("https://example.com/photo.jpg", "example.com")).toBeNull();
    expect(acceptUrl("https://example.com.evil.com/a", "example.com")).toBeNull();
  });
});

describe("sitemaps", () => {
  it("reads an index and a urlset, with CDATA and entities", () => {
    const idx = parseSitemap('<sitemapindex><sitemap><loc>https://e.com/wp-sitemap-posts-post-1.xml</loc></sitemap><sitemap><loc><![CDATA[https://e.com/wp-sitemap-taxonomies-category-1.xml]]></loc></sitemap></sitemapindex>');
    expect(idx.kind).toBe("index");
    expect(idx.locs).toHaveLength(2);
    const set = parseSitemap("<urlset><url><loc>https://e.com/a?x=1&amp;y=2</loc></url></urlset>");
    expect(set.kind).toBe("urlset");
    expect(set.locs[0]).toBe("https://e.com/a?x=1&y=2");
  });
  it("skips taxonomy, author and image sub-sitemaps", () => {
    expect(wantedSubSitemap("https://e.com/wp-sitemap-posts-post-1.xml")).toBe(true);
    expect(wantedSubSitemap("https://e.com/wp-sitemap-taxonomies-category-1.xml")).toBe(false);
    expect(wantedSubSitemap("https://e.com/wp-sitemap-users-1.xml")).toBe(false);
  });
  it("garbage gives nothing, not an exception", () => {
    expect(parseSitemap("not xml").locs).toEqual([]);
  });
});

describe("rss and wp", () => {
  it("reads rss items of the site only", () => {
    const xml = `<rss><channel><item><title><![CDATA[Peinados &amp; trenzas]]></title><link>https://e.com/peinados/</link><pubDate>Mon, 05 Jan 2026 10:00:00 +0000</pubDate><description>Ideas</description><category>Pelo</category></item><item><title>Otro</title><link>https://other.com/x</link></item></channel></rss>`;
    const r = parseRss(xml, "e.com");
    expect(r).toHaveLength(1);
    expect(r[0]?.title).toBe("Peinados & trenzas");
    expect(r[0]?.published_at).toBe("2026-01-05T10:00:00.000Z");
    expect(r[0]?.category).toBe("Pelo");
  });
  it("reads wp posts", () => {
    const r = parseWpPosts([{ link: "https://e.com/a/", title: { rendered: "Uno &#8211; dos" }, excerpt: { rendered: "<p>Texto</p>" }, date_gmt: "2026-02-01T08:00:00" }, { link: "https://x.com/b" }, 5, null], "e.com");
    expect(r).toHaveLength(1);
    expect(r[0]?.title).toBe("Uno – dos");
    expect(r[0]?.meta_description).toBe("Texto");
    expect(r[0]?.published_at).toBe("2026-02-01T08:00:00.000Z");
    expect(parseWpPosts({ code: "rest_no_route" }, "e.com")).toEqual([]);
  });
});

describe("parseUrlList", () => {
  it("dedups, filters and counts rejected", () => {
    const r = parseUrlList("https://e.com/a/\nhttps://www.e.com/a\nhttp://e.com/b, https://e.com/c;https://zz.com/d\n", "e.com");
    expect(r.urls).toEqual(["https://e.com/a/", "https://e.com/c"]);
    expect(r.rejected).toBe(2);
  });
});

describe("extractPage", () => {
  const html = `<html><head><title> Peinados para bodas | Blog </title><meta name="description" content="Ideas de peinados"><meta property="og:image" content="/img/og.jpg"><meta property="article:published_time" content="2026-03-04T10:00:00Z"><script>var x="<h1>no</h1>"</script></head>
  <body><nav><a>Menu uno dos tres</a></nav><h1>Peinados para bodas</h1><h2>Con trenzas</h2><h3>Recogidos &amp; moños</h3><p>uno dos tres cuatro cinco</p><img src="https://e.com/a.jpg"><img src="http://e.com/insecure.jpg"></body></html>`;
  it("reads title, h1, headings, meta, date, images", () => {
    const p = extractPage(html, "https://e.com/peinados/");
    expect(p.ok).toBe(true);
    expect(p.title).toBe("Peinados para bodas | Blog");
    expect(p.h1).toBe("Peinados para bodas");
    expect(p.headings).toEqual(["Con trenzas", "Recogidos & moños"]);
    expect(p.meta_description).toBe("Ideas de peinados");
    expect(p.published_at).toBe("2026-03-04T10:00:00.000Z");
    expect(p.image_urls).toEqual(["https://e.com/img/og.jpg", "https://e.com/a.jpg"]);
    expect(p.word_count).toBeGreaterThan(5);
    expect(p.content_hash).toHaveLength(40);
  });
  it("a page without title and h1 is not ok", () => {
    expect(extractPage("<html><body>hola</body></html>", "https://e.com/x").ok).toBe(false);
    expect(extractPage("", "https://e.com/x").ok).toBe(false);
  });
});
