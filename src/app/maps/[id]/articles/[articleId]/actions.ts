"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { savePost, type PostMode } from "@/modules/wordpress/client";
import { excerptOf, postContent, relatedHtml } from "@/modules/wordpress/push";
import { decryptSitePassword } from "@/modules/wordpress/secret";
import type { SchemaNode } from "@/modules/articles/publish";

/**
 * Ask for a translation gloss of a ready article. The user is authenticated here (session); article_gloss_request (0019) re-checks
 * membership, that the article is ready and the language, and is idempotent: pressing the button twice queues nothing twice.
 */
const form = z.object({ run: z.string().uuid(), article: z.string().uuid(), lang: z.enum(["en", "bn"]) });

export async function requestGloss(formData: FormData) {
  const run = String(formData.get("run") ?? "");
  const f = form.safeParse({ run, article: formData.get("article"), lang: formData.get("lang") });
  if (!f.success) redirect(/^[0-9a-f-]{36}$/i.test(run) ? `/maps/${run}/batches` : "/maps");
  const back = (flash: string) => `/maps/${f.data.run}/articles/${f.data.article}?tab=translation&lang=${f.data.lang}&flash=${flash}`;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/maps/${f.data.run}/articles/${f.data.article}`)}`);

  const res = await createAdminClient().rpc("article_gloss_request", { p_user: user.id, p_article: f.data.article, p_lang: f.data.lang });
  revalidatePath(`/maps/${f.data.run}/articles/${f.data.article}`);
  if (res.error) {
    console.error("gloss request failed", res.error.code ?? "no_code");
    const c = res.error.code;
    redirect(back(c === "PM003" ? "notready" : c === "42501" || c === "PM004" ? "gone" : "error"));
  }
  redirect(back("started"));
}

// ---------------------------------------------------------------------------
// Send to WordPress (Batch 16): saves the ready article as a DRAFT (or updates the draft saved earlier). Free, nothing is published.
// ---------------------------------------------------------------------------
const pushForm = z.object({ run: z.string().uuid(), article: z.string().uuid(), mode: z.enum(["draft", "publish", "schedule"]).default("draft"), when: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional() });
const liveRow = z.object({ title: z.string(), link: z.string() });
const targetRow = z.object({ site_id: z.string().uuid(), base_url: z.string(), wp_user: z.string(), ciphertext: z.string(), wp_post_id: z.union([z.number(), z.string()]).nullable() });
const articleRow = z.object({ title: z.string().nullable(), slug: z.string().nullable(), body_html: z.string().nullable(), meta_description: z.string().nullable(), schema_json: z.unknown(), workspace_id: z.string().uuid(), qa: z.object({ verdict: z.string().optional() }).passthrough(), locale: z.string() });

export async function sendToWordPress(formData: FormData) {
  const run = String(formData.get("run") ?? "");
  const whenRaw = formData.get("when");
  const f = pushForm.safeParse({ run, article: formData.get("article"), mode: formData.get("mode") || "draft", when: typeof whenRaw === "string" && whenRaw ? whenRaw : undefined });
  if (!f.success) redirect(/^[0-9a-f-]{36}$/i.test(run) ? `/maps/${run}/batches` : "/maps");
  const back = (flash: string, extra = "") => `/maps/${f.data.run}/articles/${f.data.article}?flash=${flash}${extra}`;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/maps/${f.data.run}/articles/${f.data.article}`)}`);
  const sb = createAdminClient();

  if (f.data.mode === "schedule" && !f.data.when) redirect(back("need_date"));
  const t = await sb.rpc("site_article_target", { p_user: user.id, p_article: f.data.article });
  if (t.error) {
    const c = t.error.code;
    redirect(back(c === "PM004" ? "no_site" : c === "22023" ? "site_choice" : c === "PM003" ? "notready" : "error"));
  }
  const target = targetRow.safeParse(Array.isArray(t.data) ? t.data[0] : t.data);
  if (!target.success) redirect(back("no_site"));
  const a = await sb.from("articles").select("title, slug, body_html, meta_description, schema_json, workspace_id, qa, locale").eq("id", f.data.article).maybeSingle();
  const art = articleRow.safeParse(a.data);
  if (!art.success || !art.data.title || !art.data.body_html) redirect(back("error"));

  // a red article is never published or scheduled from here (a draft is fine: the user can still read and fix it in WordPress)
  if (f.data.mode !== "draft" && art.data.qa.verdict === "fail") redirect(back("blocked"));

  let password: string;
  try {
    password = decryptSitePassword(art.data.workspace_id, target.data.base_url, target.data.ciphertext);
  } catch {
    redirect(back("no_master_key"));
  }
  const schema = Array.isArray(art.data.schema_json) ? (art.data.schema_json as SchemaNode[]) : null;
  const existing = target.data.wp_post_id === null ? null : Number(target.data.wp_post_id);
  // links only to articles that are really published on this site (never to drafts or unwritten ideas)
  const live = await sb.rpc("article_live_links", { p_user: user.id, p_article: f.data.article, p_site: target.data.site_id });
  const liveLinks = z.array(liveRow).safeParse(live.data ?? []);
  const related = live.error || !liveLinks.success ? "" : relatedHtml(liveLinks.data, art.data.locale);
  const mode: PostMode = f.data.mode === "publish" ? { kind: "publish" } : f.data.mode === "schedule" ? { kind: "future", date: `${f.data.when}:00` } : { kind: "keep" };
  const r = await savePost(
    { baseUrl: target.data.base_url, user: target.data.wp_user, password },
    { title: art.data.title, content: postContent(art.data.body_html, schema, related), slug: art.data.slug, excerpt: excerptOf(art.data.meta_description) },
    existing !== null && Number.isFinite(existing) ? existing : null,
    mode,
  );
  if (!r.ok) {
    console.error("wordpress push failed", r.code);
    await sb.rpc("site_record_test", { p_user: user.id, p_site: target.data.site_id, p_ok: r.code !== "bad_login" && r.code !== "no_rest_api", p_code: r.code });
    redirect(back("wp_failed", `&code=${encodeURIComponent(r.code)}`));
  }
  const saved = await sb.rpc("article_wp_saved", { p_user: user.id, p_article: f.data.article, p_site: target.data.site_id, p_post_id: r.data.id, p_edit_url: r.data.editUrl, p_status: r.data.status, p_link: r.data.link });
  revalidatePath(`/maps/${f.data.run}/articles/${f.data.article}`);
  if (saved.error) {
    console.error("wordpress save bookkeeping failed", saved.error.code ?? "no_code");
    redirect(back("sent_unsaved"));
  }
  redirect(back(!r.data.schemaKept ? "sent_noschema" : r.data.status === "publish" ? "published" : r.data.status === "future" ? "scheduled" : "sent"));
}

// ---------------------------------------------------------------------------
// Pin texts (Batch 19): ask for a set of Pinterest texts, approve or reject each pin. Free; no image and no posting yet.
// ---------------------------------------------------------------------------
const pinReq = z.object({ run: z.string().uuid(), article: z.string().uuid(), count: z.coerce.number().int().min(1).max(10).default(5) });
const pinSet = z.object({ run: z.string().uuid(), article: z.string().uuid(), pin: z.string().uuid(), status: z.enum(["approved", "rejected", "draft"]) });
const pinBack = (run: string, article: string, flash: string) => `/maps/${run}/articles/${article}?tab=pins&flash=${flash}`;

async function pinUser(run: string, article: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/maps/${run}/articles/${article}`)}`);
  return user;
}

export async function requestPins(formData: FormData) {
  const f = pinReq.safeParse({ run: formData.get("run"), article: formData.get("article"), count: formData.get("count") ?? 5 });
  if (!f.success) redirect("/maps");
  const user = await pinUser(f.data.run, f.data.article);
  const res = await createAdminClient().rpc("pin_copy_request", { p_user: user.id, p_article: f.data.article, p_count: f.data.count });
  revalidatePath(`/maps/${f.data.run}/articles/${f.data.article}`);
  if (res.error) {
    console.error("pin request failed", res.error.code ?? "no_code");
    const c = res.error.code;
    redirect(pinBack(f.data.run, f.data.article, c === "PM003" ? (String(res.error.message).includes("pins_exist") ? "pins_exist" : "notready") : c === "42501" || c === "PM004" ? "gone" : "error"));
  }
  redirect(pinBack(f.data.run, f.data.article, "pins_started"));
}

export async function setPinStatus(formData: FormData) {
  const f = pinSet.safeParse({ run: formData.get("run"), article: formData.get("article"), pin: formData.get("pin"), status: formData.get("status") });
  if (!f.success) redirect("/maps");
  const user = await pinUser(f.data.run, f.data.article);
  const res = await createAdminClient().rpc("pin_set_status", { p_user: user.id, p_pin: f.data.pin, p_status: f.data.status });
  revalidatePath(`/maps/${f.data.run}/articles/${f.data.article}`);
  if (res.error) console.error("pin status failed", res.error.code ?? "no_code");
  redirect(pinBack(f.data.run, f.data.article, res.error ? "error" : "pin_saved"));
}
