import type { Locale } from "@/modules/topical-map/lexicon";
import type { LinkPlan } from "@/modules/topical-map/links";
import type { QaCheck, QaReport, QaStatus } from "./qa";
import type { ArticleParts } from "./render";

/**
 * What an article needs besides its text before it can be published (Batch 15): a meta description, schema.org JSON-LD and
 * the planned internal links. All built by code from the finished article; the model only suggests the meta description.
 * Links are stored as a list, NOT written into the HTML: the publisher links only to articles that really exist (see 0020).
 */

export const META_MIN = 70;
export const META_MAX = 155;

const clean = (s: string) => s.replace(/\s+/g, " ").replace(/["“”]/g, "").trim();

/** Cuts at a word boundary, at most `max` characters, ending in a full stop-less clean sentence (no trailing comma/colon). */
export function cutAtWord(s: string, max: number): string {
  const t = clean(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const at = cut.lastIndexOf(" ");
  return cut.slice(0, at > max * 0.6 ? at : max).replace(/[\s,;:–—-]+$/, "");
}

/** The model's suggestion when it is usable, else the start of the intro. */
export function metaDescription(suggested: string | undefined, intro: string[]): string {
  const s = clean(suggested ?? "");
  if (s.length >= META_MIN) return cutAtWord(s, META_MAX);
  return cutAtWord(intro.join(" "), META_MAX);
}

export type SchemaNode = Record<string, unknown>;

export function buildSchema(a: ArticleParts, meta: string): SchemaNode[] {
  const lang = a.locale;
  const nodes: SchemaNode[] = [
    { "@context": "https://schema.org", "@type": "Article", headline: a.title.slice(0, 110), description: meta, inLanguage: lang },
  ];
  if (a.items.length) {
    nodes.push({
      "@context": "https://schema.org", "@type": "ItemList", name: a.title, numberOfItems: a.items.length,
      itemListElement: a.items.map((it, k) => ({ "@type": "ListItem", position: k + 1, name: it.heading })),
    });
  }
  if (a.faq.items.length) {
    nodes.push({
      "@context": "https://schema.org", "@type": "FAQPage",
      mainEntity: a.faq.items.map((q) => ({ "@type": "Question", name: q.question, acceptedAnswer: { "@type": "Answer", text: q.answer } })),
    });
  }
  return nodes;
}

export type RelatedLink = { plan_item_id: string; role: "pillar" | "sibling" | "child"; title: string; slug: string };
export type LinkTarget = { id: string; title: string | null; slug: string | null; status: string };

/** Planned links in a stable order: pillar, siblings, children. Drops missing, rejected, untitled or self targets and duplicates. */
export function buildLinks(plan: LinkPlan | null | undefined, selfId: string, targets: LinkTarget[]): RelatedLink[] {
  if (!plan) return [];
  const byId = new Map(targets.map((t) => [t.id, t]));
  const seen = new Set<string>([selfId]);
  const out: RelatedLink[] = [];
  const add = (id: string | null, role: RelatedLink["role"]) => {
    if (!id || seen.has(id)) return;
    const t = byId.get(id);
    if (!t || t.status === "rejected" || !t.title || !t.slug) return;
    seen.add(id);
    out.push({ plan_item_id: id, role, title: t.title, slug: t.slug });
  };
  add(plan.pillar, "pillar");
  plan.siblings.forEach((id) => add(id, "sibling"));
  plan.children.forEach((id) => add(id, "child"));
  return out;
}

/** Checks added to the QA report. The schema check re-parses what will be stored, so a broken document is caught here. */
export function publishChecks(meta: string, schema: SchemaNode[], links: RelatedLink[], locale: Locale): QaCheck[] {
  const checks: QaCheck[] = [];
  const add = (id: string, status: QaStatus, summary: string) => checks.push({ id, status, summary });
  const m = meta.length;
  add("meta", m >= META_MIN && m <= META_MAX ? "pass" : "flag", `meta description ${m} characters (aim ${META_MIN}-${META_MAX})`);
  let ok = false;
  try {
    const back = JSON.parse(JSON.stringify(schema)) as SchemaNode[];
    ok = Array.isArray(back) && back.length > 0 && back.every((n) => typeof n["@type"] === "string") && back[0]?.["inLanguage"] === locale;
  } catch { ok = false; }
  add("schema", ok ? "pass" : "fail", ok ? `schema: ${schema.map((n) => String(n["@type"])).join(", ")}` : "schema document is invalid");
  add("links", links.length > 0 ? "pass" : "flag", links.length > 0 ? `${links.length} planned internal links` : "no planned internal links for this article");
  return checks;
}

const PUBLISH_IDS = new Set(["meta", "schema", "links"]);

/** Adds (replaces) the publish checks of a report and recomputes the verdict. */
export function withPublishChecks(qa: QaReport, extra: QaCheck[]): QaReport {
  const checks = [...qa.checks.filter((c) => !PUBLISH_IDS.has(c.id)), ...extra];
  const verdict: QaStatus = checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "flag") ? "flag" : "pass";
  return { ...qa, checks, verdict };
}
