"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { sendArticle, type SendMode } from "@/modules/wordpress/send";
import type { RelatedLink } from "@/modules/articles/publish";
import { parseEditForm, partsOfEdit, rebuildAfterEdit, sectionRows } from "@/modules/articles/edit";
import { storedOutlineSchema } from "@/modules/articles/prompts";
import type { ArticleParts } from "@/modules/articles/render";
import { storedReviewSchema } from "@/modules/articles/review";

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

export async function sendToWordPress(formData: FormData) {
  const run = String(formData.get("run") ?? "");
  const whenRaw = formData.get("when");
  const f = pushForm.safeParse({ run, article: formData.get("article"), mode: formData.get("mode") || "draft", when: typeof whenRaw === "string" && whenRaw ? whenRaw : undefined });
  if (!f.success) redirect(/^[0-9a-f-]{36}$/i.test(run) ? `/maps/${run}/batches` : "/maps");
  const back = (flash: string, extra = "") => `/maps/${f.data.run}/articles/${f.data.article}?flash=${flash}${extra}`;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/maps/${f.data.run}/articles/${f.data.article}`)}`);
  if (f.data.mode === "schedule" && !f.data.when) redirect(back("need_date"));

  const mode: SendMode = f.data.mode === "publish" ? { kind: "publish" } : f.data.mode === "schedule" ? { kind: "future", when: f.data.when ?? "" } : { kind: "draft" };
  const r = await sendArticle(createAdminClient(), user.id, f.data.article, mode);
  revalidatePath(`/maps/${f.data.run}/articles/${f.data.article}`);
  if (!r.ok) {
    console.error("wordpress send failed", r.code);
    const known = ["no_site", "site_choice", "notready", "blocked", "no_master_key", "error"];
    if (r.code === "unsaved") redirect(back("sent_unsaved"));
    redirect(known.includes(r.code) ? back(r.code) : back("wp_failed", `&code=${encodeURIComponent(r.code)}`));
  }
  redirect(back(!r.schemaKept ? "sent_noschema" : r.status === "publish" ? "published" : r.status === "future" ? "scheduled" : "sent"));
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

// ---------------------------------------------------------------------------
// Edit the text of a finished article (Batch 20). Free. The AI language review is not re-run; the QA says so.
// ---------------------------------------------------------------------------
const editIds = z.object({ run: z.string().uuid(), article: z.string().uuid() });
const sectionRowsSchema = z.array(z.object({ kind: z.string(), idx: z.number(), content: z.unknown() }));
const planRow = z.object({ target_words: z.number().int(), slug: z.string().nullable() });

export async function saveArticleEdit(formData: FormData) {
  const ids = editIds.safeParse({ run: formData.get("run"), article: formData.get("article") });
  if (!ids.success) redirect("/maps");
  const back = (flash: string, field = "") => `/maps/${ids.data.run}/articles/${ids.data.article}?tab=edit&flash=${flash}${field ? `&field=${encodeURIComponent(field)}` : ""}`;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/maps/${ids.data.run}/articles/${ids.data.article}`)}`);

  // the session client only sees articles of the user's own workspace (RLS)
  const own = await supabase.from("articles").select("id").eq("id", ids.data.article).eq("map_run_id", ids.data.run).maybeSingle();
  if (!own.data) redirect(back("gone"));
  const sb = createAdminClient();
  const [art, secs] = await Promise.all([
    sb.from("articles").select("status, locale, slug, outline, review, links, plan_item_id, title").eq("id", ids.data.article).maybeSingle(),
    sb.from("article_sections").select("kind, idx, content").eq("article_id", ids.data.article),
  ]);
  const outline = storedOutlineSchema.safeParse(art.data?.outline);
  const rows = sectionRowsSchema.safeParse(secs.data ?? []);
  if (art.error || !art.data || art.data.status !== "ready" || !outline.success || !rows.success) redirect(back("edit_notready"));
  const plan = planRow.safeParse((await sb.from("plan_items").select("target_words, slug").eq("id", art.data.plan_item_id).maybeSingle()).data);
  if (!plan.success) redirect(back("error"));

  const get = (k: string) => String(formData.get(k) ?? "");
  const parsed = parseEditForm(get, outline.data.n, outline.data.faq.length);
  if (!parsed.ok) redirect(back("edit_invalid", parsed.error.message));  // the message travels in the `field` parameter (plain text, shown escaped by React)
  const e = parsed.value;

  const saved = await sb.rpc("article_edit_save", { p_user: user.id, p_article: ids.data.article, p_title: e.title, p_sections: sectionRows(e) });
  if (saved.error) {
    console.error("article edit failed", saved.error.code ?? "no_code");
    redirect(back(saved.error.code === "PM003" ? "edit_notready" : "error"));
  }

  const base: ArticleParts = {
    title: e.title, locale: art.data.locale as ArticleParts["locale"], highlights: outline.data.highlights,
    intro: { paragraphs: e.intro }, items: e.items, faq: { items: e.faq }, conclusion: { paragraphs: e.conclusion },
  };
  const review = storedReviewSchema.safeParse(art.data.review);
  const links = (Array.isArray(art.data.links) ? art.data.links : []) as RelatedLink[];
  const built = rebuildAfterEdit({ parts: partsOfEdit(base, e), slug: art.data.slug ?? plan.data.slug, n: outline.data.n, targetWords: plan.data.target_words, meta: e.meta, links, hadReview: review.success && review.data.status === "done", lastVerdict: review.success ? (review.data.verdict ?? null) : null });
  const up = await sb.from("articles").update({ body_html: built.html, qa: built.qa, word_count: built.words, meta_description: built.meta, schema_json: built.schema, stats: { qa_verdict: built.qa.verdict, edited: true } }).eq("id", ids.data.article).eq("status", "ready");
  revalidatePath(`/maps/${ids.data.run}/articles/${ids.data.article}`);
  if (up.error) {
    console.error("article edit rebuild failed", up.error.code ?? "no_code");
    redirect(back("edit_half"));
  }
  redirect(`/maps/${ids.data.run}/articles/${ids.data.article}?flash=edited`);
}
