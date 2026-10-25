import type { SchemaNode } from "@/modules/articles/publish";

/**
 * The post body sent to WordPress: the article HTML without its <h1> (the theme prints the post title as the h1) plus the
 * JSON-LD script. `<` is escaped inside the JSON so the script can never be closed early by article text.
 */
export function postContent(bodyHtml: string, schema: SchemaNode[] | null, related = ""): string {
  const body = bodyHtml.replace(/^\s*<h1>[\s\S]*?<\/h1>\s*/, "") + (related ? `\n\n${related}` : "");
  if (!schema || schema.length === 0) return body;
  const json = JSON.stringify(schema.length === 1 ? schema[0] : schema).replace(/</g, "\\u003c");
  return `${body}\n\n<script type="application/ld+json">${json}</script>`;
}

/** Excerpt = meta description: core WordPress has no meta-description field; SEO plugins can read the excerpt (a companion plugin comes later). */
export const excerptOf = (meta: string | null) => (meta && meta.trim().length > 0 ? meta.trim() : null);

const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const RELATED_HEADING = { es: "Sigue leyendo", en: "Related reading" } as const;

/** "Related reading" block with links to articles that are really published (only https links; text escaped). Empty when there are none. */
export function relatedHtml(links: { title: string; link: string }[], locale: string): string {
  const ok = links.filter((l) => l.link.startsWith("https://") && l.title.trim().length > 0);
  if (ok.length === 0) return "";
  const h = locale.startsWith("es") ? RELATED_HEADING.es : RELATED_HEADING.en;
  return `<h2>${h}</h2>\n<ul>\n${ok.map((l) => `<li><a href="${esc(l.link)}">${esc(l.title)}</a></li>`).join("\n")}\n</ul>`;
}
