import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SchemaNode } from "@/modules/articles/publish";
import { savePost, type PostMode, type PostResult } from "./client";
import { excerptOf, postContent, relatedHtml } from "./push";
import { decryptSitePassword } from "./secret";

/**
 * Sends one finished article to its WordPress site (the one place that does it: the article page button and the background
 * `wp.send` job both call this). All database access goes through the SQL functions of 0021/0022 with the requesting user's id,
 * which re-check membership. A red article (QA verdict fail) is never published or scheduled; saving it as a draft is allowed.
 */
export type SendMode = { kind: "draft" } | { kind: "publish" } | { kind: "future"; when: string };
export type SendCode = "no_site" | "site_choice" | "notready" | "blocked" | "no_master_key" | "error" | "unsaved" | string;
export type SendResult = { ok: true; status: PostResult["status"]; schemaKept: boolean } | { ok: false; code: SendCode; retryable: boolean };

const targetRow = z.object({ site_id: z.string().uuid(), base_url: z.string(), wp_user: z.string(), ciphertext: z.string(), wp_post_id: z.union([z.number(), z.string()]).nullable() });
const articleRow = z.object({ title: z.string().nullable(), slug: z.string().nullable(), body_html: z.string().nullable(), meta_description: z.string().nullable(), schema_json: z.unknown(), workspace_id: z.string().uuid(), qa: z.object({ verdict: z.string().optional() }).passthrough(), locale: z.string() });
const liveRow = z.object({ title: z.string(), link: z.string() });

/** Network-type failures may succeed on a retry; a wrong password or a missing site will not. */
export const isRetryableWpCode = (c: string) => c === "timeout" || c === "network_error" || c === "dns_failed" || /^http_5\d\d$/.test(c) || c === "http_429";

export async function sendArticle(sb: SupabaseClient, userId: string, articleId: string, mode: SendMode): Promise<SendResult> {
  const fail = (code: SendCode, retryable = false): SendResult => ({ ok: false, code, retryable });
  const t = await sb.rpc("site_article_target", { p_user: userId, p_article: articleId });
  if (t.error) {
    const c = t.error.code;
    return fail(c === "PM004" ? "no_site" : c === "22023" ? "site_choice" : c === "PM003" ? "notready" : "error", c !== "PM004" && c !== "22023" && c !== "PM003" && c !== "42501");
  }
  const target = targetRow.safeParse(Array.isArray(t.data) ? t.data[0] : t.data);
  if (!target.success) return fail("no_site");
  const a = await sb.from("articles").select("title, slug, body_html, meta_description, schema_json, workspace_id, qa, locale").eq("id", articleId).maybeSingle();
  const art = articleRow.safeParse(a.data);
  if (!art.success || !art.data.title || !art.data.body_html) return fail("error");
  if (mode.kind !== "draft" && art.data.qa.verdict === "fail") return fail("blocked");

  let password: string;
  try {
    password = decryptSitePassword(art.data.workspace_id, target.data.base_url, target.data.ciphertext);
  } catch {
    return fail("no_master_key");
  }
  const schema = Array.isArray(art.data.schema_json) ? (art.data.schema_json as SchemaNode[]) : null;
  const existing = target.data.wp_post_id === null ? null : Number(target.data.wp_post_id);
  const live = await sb.rpc("article_live_links", { p_user: userId, p_article: articleId, p_site: target.data.site_id });
  const liveLinks = z.array(liveRow).safeParse(live.data ?? []);
  const related = live.error || !liveLinks.success ? "" : relatedHtml(liveLinks.data, art.data.locale);
  const post: PostMode = mode.kind === "publish" ? { kind: "publish" } : mode.kind === "future" ? { kind: "future", date: `${mode.when}:00` } : { kind: "keep" };
  const r = await savePost(
    { baseUrl: target.data.base_url, user: target.data.wp_user, password },
    { title: art.data.title, content: postContent(art.data.body_html, schema, related), slug: art.data.slug, excerpt: excerptOf(art.data.meta_description) },
    existing !== null && Number.isFinite(existing) ? existing : null,
    post,
  );
  if (!r.ok) {
    await sb.rpc("site_record_test", { p_user: userId, p_site: target.data.site_id, p_ok: r.code !== "bad_login" && r.code !== "no_rest_api", p_code: r.code });
    return fail(r.code, isRetryableWpCode(r.code));
  }
  const saved = await sb.rpc("article_wp_saved", { p_user: userId, p_article: articleId, p_site: target.data.site_id, p_post_id: r.data.id, p_edit_url: r.data.editUrl, p_status: r.data.status, p_link: r.data.link });
  // the post exists in WordPress now; if only our note-keeping failed, a retry would create a second post, so this is NOT retryable
  if (saved.error) return fail("unsaved");
  return { ok: true, status: r.data.status, schemaKept: r.data.schemaKept };
}
