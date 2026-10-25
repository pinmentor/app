import type { SchemaNode } from "@/modules/articles/publish";

/**
 * The post body sent to WordPress: the article HTML without its <h1> (the theme prints the post title as the h1) plus the
 * JSON-LD script. `<` is escaped inside the JSON so the script can never be closed early by article text.
 */
export function postContent(bodyHtml: string, schema: SchemaNode[] | null): string {
  const body = bodyHtml.replace(/^\s*<h1>[\s\S]*?<\/h1>\s*/, "");
  if (!schema || schema.length === 0) return body;
  const json = JSON.stringify(schema.length === 1 ? schema[0] : schema).replace(/</g, "\\u003c");
  return `${body}\n\n<script type="application/ld+json">${json}</script>`;
}

/** Excerpt = meta description: core WordPress has no meta-description field; SEO plugins can read the excerpt (a companion plugin comes later). */
export const excerptOf = (meta: string | null) => (meta && meta.trim().length > 0 ? meta.trim() : null);
