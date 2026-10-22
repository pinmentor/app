import { z } from "zod";
import { callLlm } from "@/modules/llm/client";
import { JobError, type JobContext, type JobHandler } from "@/modules/jobs/types";
import { db, enqueue, LOCALES, parsePayload, rpc, uuid } from "@/modules/topical-map/stage-kit";
import {
  faqPrompt, faqSchema, introPrompt, introSchema, itemsPrompt, itemsSchema, ITEMS_PER_JOB, outlinePrompt, outlineSchema, storedOutlineSchema, wordsPerItem,
  type ConclusionContent, type FaqContent, type IntroContent, type ItemContent, type StoredOutline,
} from "./prompts";
import { renderArticle, countWords, plainText, type ArticleParts } from "./render";
import { qaArticle, type QaReport } from "./qa";
import { LlmError } from "@/modules/llm/errors";
import type { ProviderName } from "@/modules/llm/errors";
import { mergeReview, reviewPrompt, reviewSchema, reviewText, type StoredReview } from "./review";
import * as G from "./gloss";

/**
 * Article writer v1 (Type A). (Batch 13: assemble no longer finishes the article; a review job does, see below.) Three kinds of short, idempotent jobs, all keyed by article id:
 *   article.outline  -> plans the list, stores the outline, enqueues the section jobs
 *   article.sections -> writes ONE part (intro | up to 5 items | faq+conclusion), stores it, and the job that completes the set enqueues assemble
 *   article.assemble -> renders escaped HTML, runs the mechanical QA, marks the article ready (article_finish settles the batch)
 * A job that fails for the last time marks the article failed (free for the user); article_watchdog catches jobs that died silently.
 */

const MAX_ATTEMPTS = 3; // must match enqueue() in stage-kit
const articlePayload = z.object({ articleId: uuid });
const sectionPayload = z.object({ articleId: uuid, part: z.string().regex(/^(intro|faq|items:\d{1,3})$/) });

const articleRow = z.object({
  id: uuid, workspace_id: uuid, status: z.string(), keyword: z.string(), locale: z.enum(LOCALES), title: z.string().nullable(), slug: z.string().nullable(),
  outline: z.unknown(), plan_item_id: uuid,
});
const itemRow = z.object({ title: z.string().nullable(), slug: z.string().nullable(), list_count: z.number().int().nullable(), target_words: z.number().int(), variants: z.array(z.string()), silo_id: uuid.nullable() });

type Loaded = { art: z.infer<typeof articleRow>; item: z.infer<typeof itemRow>; silo: string | null };

/** The live article of this workspace plus its plan item, or null when it is already final (a late or replayed job does nothing). */
async function load(ctx: JobContext, articleId: string): Promise<Loaded | null> {
  const a = await db().from("articles").select("id, workspace_id, status, keyword, locale, title, slug, outline, plan_item_id").eq("id", articleId).eq("workspace_id", ctx.workspaceId).maybeSingle();
  if (a.error) throw new JobError("article lookup failed", "db_error", { retryable: true });
  if (!a.data) throw new JobError("article not found", "article_not_found", { retryable: false });
  const art = articleRow.safeParse(a.data);
  if (!art.success) throw new JobError("article row invalid", "db_invalid_row", { retryable: false });
  if (art.data.status !== "queued" && art.data.status !== "writing") return null;
  const p = await db().from("plan_items").select("title, slug, list_count, target_words, variants, silo_id").eq("id", art.data.plan_item_id).maybeSingle();
  if (p.error) throw new JobError("item lookup failed", "db_error", { retryable: true });
  const item = itemRow.safeParse(p.data);
  if (!item.success) throw new JobError("item row invalid", "db_invalid_row", { retryable: false });
  let silo: string | null = null;
  if (item.data.silo_id) {
    const s = await db().from("silos").select("name").eq("id", item.data.silo_id).maybeSingle();
    silo = typeof s.data?.name === "string" ? s.data.name : null;
  }
  return { art: art.data, item: item.data, silo };
}

async function failArticle(articleId: string, code: string): Promise<void> {
  await rpc("article_finish", { p_article: articleId, p_status: "failed", p_error: code, p_patch: null });
}

/** Runs one job body; on the LAST attempt a thrown error also fails the article so the user is not charged and the item is freed. */
function guarded(body: (ctx: JobContext) => Promise<Record<string, unknown>>): JobHandler {
  return async (ctx) => {
    try {
      return await body(ctx);
    } catch (e) {
      const id = articlePayload.safeParse(ctx.payload);
      const final = e instanceof JobError ? !e.retryable : ctx.attempt >= MAX_ATTEMPTS;
      if (id.success && final) {
        try { await failArticle(id.data.articleId, e instanceof JobError ? e.code : (e as { code?: string }).code ?? "write_failed"); } catch { /* the watchdog will catch it */ }
      }
      throw e;
    }
  };
}

function storedOutline(l: Loaded): StoredOutline {
  const o = storedOutlineSchema.safeParse(l.art.outline);
  if (!o.success) throw new JobError("outline missing", "outline_missing", { retryable: false });
  return o.data;
}
const ctxOf = (l: Loaded) => ({ title: l.item.title ?? l.art.keyword, keyword: l.art.keyword, locale: l.art.locale });

// ---------------------------------------------------------------------------
const outlineJob: JobHandler = guarded(async (ctx) => {
  const { articleId } = parsePayload(articlePayload, ctx.payload);
  const l = await load(ctx, articleId);
  if (!l) return { skipped: "final" };
  const n = l.item.list_count;
  if (!l.item.title || n === null) throw new JobError("item has no title or list number", "item_not_ready", { retryable: false });

  const done = storedOutlineSchema.safeParse(l.art.outline);
  if (!done.success) {
    const p = outlinePrompt({ keyword: l.art.keyword, variants: l.item.variants, title: l.item.title, n, locale: l.art.locale, silo: l.silo });
    const r = await callLlm({ task: "research_outline", workspaceId: ctx.workspaceId, jobId: ctx.jobId, system: p.system, prompt: p.prompt, schema: outlineSchema(n), maxOutputTokens: 6000, temperature: 0.4 });
    const stored: StoredOutline = { n, highlights: r.data.highlights, intro_angle: r.data.intro_angle, items: r.data.items, faq: r.data.faq, conclusion_angle: r.data.conclusion_angle };
    const up = await db().from("articles").update({ status: "writing", title: l.item.title, slug: l.item.slug, outline: stored }).eq("id", articleId).in("status", ["queued", "writing"]);
    if (up.error) throw new JobError("outline save failed", "db_error", { retryable: true });
  }
  const o = done.success ? done.data : storedOutlineSchema.parse((await load(ctx, articleId))?.art.outline);
  const parts = ["intro", ...Array.from({ length: Math.ceil(o.n / ITEMS_PER_JOB) }, (_, k) => `items:${k * ITEMS_PER_JOB}`), "faq"];
  for (const part of parts) await enqueue(ctx, "article.sections", { articleId, part }, `article:${articleId}:sec:${part}`, { stage: "sections" });
  return { parts: parts.length };
});

// ---------------------------------------------------------------------------
type Section = { article_id: string; workspace_id: string; kind: "intro" | "item" | "faq" | "conclusion"; idx: number; content: unknown; words: number };

async function storedKinds(articleId: string): Promise<{ kind: string; idx: number }[]> {
  const r = await db().from("article_sections").select("kind, idx").eq("article_id", articleId);
  if (r.error) throw new JobError("sections read failed", "db_error", { retryable: true });
  return (r.data ?? []) as { kind: string; idx: number }[];
}

async function saveSections(rows: Section[]): Promise<void> {
  if (rows.length === 0) return;
  const r = await db().from("article_sections").upsert(rows, { onConflict: "article_id,kind,idx" });
  if (r.error) throw new JobError("section save failed", "db_error", { retryable: true });
}

const wordsOf = (xs: string[]) => countWords(xs.join(" "));

const sectionsJob: JobHandler = guarded(async (ctx) => {
  const { articleId, part } = parsePayload(sectionPayload, ctx.payload);
  const l = await load(ctx, articleId);
  if (!l) return { skipped: "final" };
  const o = storedOutline(l);
  const c = ctxOf(l);
  const base = { article_id: articleId, workspace_id: ctx.workspaceId };
  const have = await storedKinds(articleId);
  const has = (kind: string, idx: number) => have.some((h) => h.kind === kind && h.idx === idx);

  if (part === "intro") {
    if (!has("intro", 0)) {
      const p = introPrompt(c, o);
      const r = await callLlm({ task: "article_write", workspaceId: ctx.workspaceId, jobId: ctx.jobId, system: p.system, prompt: p.prompt, schema: introSchema, maxOutputTokens: 1500, temperature: 0.7 });
      const content: IntroContent = { paragraphs: r.data.intro };
      await saveSections([{ ...base, kind: "intro", idx: 0, content, words: wordsOf(content.paragraphs) }]);
    }
  } else if (part === "faq") {
    if (!has("faq", 0) || !has("conclusion", 0)) {
      const p = faqPrompt(c, o);
      const r = await callLlm({ task: "article_write", workspaceId: ctx.workspaceId, jobId: ctx.jobId, system: p.system, prompt: p.prompt, schema: faqSchema, maxOutputTokens: 3000, temperature: 0.7 });
      const faq: FaqContent = { items: r.data.faq.slice(0, o.faq.length) };
      const conclusion: ConclusionContent = { paragraphs: r.data.conclusion };
      await saveSections([
        { ...base, kind: "faq", idx: 0, content: faq, words: wordsOf(faq.items.flatMap((q) => [q.question, q.answer])) },
        { ...base, kind: "conclusion", idx: 0, content: conclusion, words: wordsOf(conclusion.paragraphs) },
      ]);
    }
  } else {
    const from = Number(part.slice("items:".length));
    const to = Math.min(o.n, from + ITEMS_PER_JOB);
    const missing = Array.from({ length: to - from }, (_, k) => from + k).filter((i) => !has("item", i));
    if (missing.length > 0) {
      // only the items still missing are asked for (a retry after a partial answer pays for the rest only)
      const first = missing[0]!;
      const last = missing[missing.length - 1]! + 1;
      const p = itemsPrompt(c, o, first, last, wordsPerItem(l.item.target_words, o.n));
      const r = await callLlm({ task: "article_write", workspaceId: ctx.workspaceId, jobId: ctx.jobId, system: p.system, prompt: p.prompt, schema: itemsSchema, maxOutputTokens: 6000, temperature: 0.7 });
      const rows: Section[] = [];
      for (const it of r.data) {
        const idx = it.i - 1;
        if (!missing.includes(idx) || rows.some((x) => x.idx === idx)) continue;
        const content: ItemContent = { heading: o.items[idx]!.heading, paragraphs: it.paragraphs, bullets: it.bullets };
        rows.push({ ...base, kind: "item", idx, content, words: wordsOf([...it.paragraphs, ...it.bullets]) });
      }
      await saveSections(rows);
      if (rows.length < missing.length) throw new JobError("model skipped some items", "items_missing", { retryable: true, retryAfterSeconds: 2 });
    }
  }

  // the job that completes the set starts assembly (the key makes a second enqueue a no-op)
  const now = await storedKinds(articleId);
  if (now.length >= o.n + 3) await enqueue(ctx, "article.assemble", { articleId }, `article:${articleId}:assemble`, { stage: "assemble" });
  return { part, stored: now.length };
});

// ---------------------------------------------------------------------------
type Sections = { rows: { kind: string; idx: number; content: unknown }[] };

async function readSections(articleId: string): Promise<Sections> {
  const r = await db().from("article_sections").select("kind, idx, content").eq("article_id", articleId).order("idx");
  if (r.error) throw new JobError("sections read failed", "db_error", { retryable: true });
  return { rows: (r.data ?? []) as Sections["rows"] };
}
const pick = <T,>(s: Sections, kind: string, idx = 0) => s.rows.find((x) => x.kind === kind && x.idx === idx)?.content as T | undefined;

/** The article's parts from the stored sections, or null while something is still missing. */
function partsOf(l: Loaded, o: StoredOutline, s: Sections): ArticleParts | null {
  const intro = pick<IntroContent>(s, "intro");
  const faq = pick<FaqContent>(s, "faq");
  const conclusion = pick<ConclusionContent>(s, "conclusion");
  const items = Array.from({ length: o.n }, (_, i) => pick<ItemContent>(s, "item", i));
  if (!intro || !faq || !conclusion || items.some((x) => !x)) return null;
  return { title: l.item.title ?? l.art.keyword, locale: l.art.locale, highlights: o.highlights, intro, items: items as ItemContent[], faq, conclusion };
}

/** Renders and runs the mechanical QA, stores them (the article stays `writing`) and hands over to the language review. */
const assembleJob: JobHandler = guarded(async (ctx) => {
  const { articleId } = parsePayload(articlePayload, ctx.payload);
  const l = await load(ctx, articleId);
  if (!l) return { skipped: "final" };
  const o = storedOutline(l);
  const parts = partsOf(l, o, await readSections(articleId));
  if (!parts) throw new JobError("sections incomplete", "sections_incomplete", { retryable: true, retryAfterSeconds: 5 });

  const html = renderArticle(parts);
  const qa = qaArticle(parts, l.item.slug, o.n, l.item.target_words);
  const words = countWords(plainText(parts));
  const up = await db().from("articles").update({ title: parts.title, slug: l.item.slug, body_html: html, word_count: words, qa, stats: { qa_verdict: qa.verdict, items: o.n } }).eq("id", articleId).in("status", ["queued", "writing"]);
  if (up.error) throw new JobError("assemble save failed", "db_error", { retryable: true });
  await enqueue(ctx, "article.review", { articleId }, `article:${articleId}:review`, { stage: "review" });
  return { words, qa: qa.verdict };
});

/** Provider of the model that wrote the sections (so the reviewer can be a different one), from the LLM call log. */
async function writerProvider(articleId: string): Promise<ProviderName | undefined> {
  const jobs = await db().from("jobs").select("id").eq("type", "article.sections").eq("payload->>articleId", articleId).limit(50);
  const ids = ((jobs.data ?? []) as { id: string }[]).map((j) => j.id);
  if (jobs.error || ids.length === 0) return undefined;
  const calls = await db().from("llm_calls").select("provider").in("job_id", ids).eq("task", "article_write").eq("status", "ok").limit(1);
  const p = (calls.data as { provider?: string }[] | null)?.[0]?.provider;
  return p === "anthropic" || p === "openai" || p === "gemini" ? p : undefined;
}

const storedQa = z.object({ verdict: z.enum(["pass", "flag", "fail"]), words: z.number(), checks: z.array(z.object({ id: z.string(), status: z.enum(["pass", "flag", "fail"]), summary: z.string() })) });

/**
 * Language review by a second model, then the article is finished `ready` (this is where the batch can settle).
 * Never blocks the article: when the review cannot run (no key, provider down on the last attempt) it is recorded as skipped,
 * which is a yellow flag in the QA report, not a pass. Earlier attempts retry normally.
 */
const reviewJob: JobHandler = async (ctx) => {
  const { articleId } = parsePayload(articlePayload, ctx.payload);
  const l = await load(ctx, articleId);
  if (!l) return { skipped: "final" };
  const o = storedOutline(l);
  const sec = await readSections(articleId);
  const parts = partsOf(l, o, sec);
  if (!parts) throw new JobError("sections incomplete", "sections_incomplete", { retryable: false });
  const row = await db().from("articles").select("qa, title, slug, body_html, word_count").eq("id", articleId).maybeSingle();
  const qa = storedQa.safeParse(row.data?.qa);
  if (row.error || !qa.success || !row.data) throw new JobError("assembled article missing", "assemble_missing", { retryable: false });

  let review: StoredReview;
  try {
    const p = reviewPrompt(reviewText(parts), l.art.locale);
    const avoid = await writerProvider(articleId);
    let cross = avoid !== undefined;
    const base = { task: "qa_cross_judge", workspaceId: ctx.workspaceId, jobId: ctx.jobId, system: p.system, prompt: p.prompt, schema: reviewSchema, maxOutputTokens: 6000, temperature: 0 };
    let r;
    try {
      r = await callLlm({ ...base, avoidProvider: avoid });
    } catch (e) {
      if (!(e instanceof LlmError) || e.code !== "no_route" || avoid === undefined) throw e;
      cross = false; // only the writer's provider has a key: review with it, and say so
      r = await callLlm(base);
    }
    review = { status: "done", verdict: r.data.verdict, issues: r.data.issues, risky_claims: r.data.risky_claims, model: r.modelKey, provider: r.provider, cross_model: cross && r.provider !== avoid };
  } catch (e) {
    const code = e instanceof LlmError || e instanceof JobError ? e.code : "unexpected";
    if (ctx.attempt < MAX_ATTEMPTS && !(e instanceof LlmError && !e.retryable)) throw e;
    review = { status: "skipped", issues: [], risky_claims: [], reason: code };
  }

  const merged: QaReport = mergeReview(qa.data, review);
  await rpc("article_finish", {
    p_article: articleId,
    p_status: "ready",
    p_error: null,
    p_patch: { title: row.data.title, slug: row.data.slug, body_html: row.data.body_html, word_count: row.data.word_count, qa: merged, review, stats: { qa_verdict: merged.verdict, items: o.n, review: review.status } },
  });
  return { review: review.status, verdict: merged.verdict };
};

// ---------------------------------------------------------------------------
// Translation gloss (on demand, article is already ready): one job per part; a part that already exists is skipped.
const glossPayload = z.object({ glossArticleId: uuid, lang: z.enum(["en", "bn"]), part: z.string().regex(G.partPattern) });

const glossJob: JobHandler = async (ctx) => {
  const { glossArticleId, lang, part } = parsePayload(glossPayload, ctx.payload);
  const a = await db().from("articles").select("id, workspace_id, status, outline").eq("id", glossArticleId).eq("workspace_id", ctx.workspaceId).maybeSingle();
  if (a.error) throw new JobError("article lookup failed", "db_error", { retryable: true });
  if (!a.data || a.data.status !== "ready") return { skipped: "not_ready" };
  const o = storedOutlineSchema.safeParse(a.data.outline);
  if (!o.success) throw new JobError("outline missing", "outline_missing", { retryable: false });
  const n = o.data.n;
  const sec = await readSections(glossArticleId);
  const have = await db().from("article_gloss").select("kind, idx").eq("article_id", glossArticleId).eq("lang", lang);
  if (have.error) throw new JobError("gloss read failed", "db_error", { retryable: true });
  const has = (kind: string, idx: number) => ((have.data ?? []) as { kind: string; idx: number }[]).some((h) => h.kind === kind && h.idx === idx);
  const base = { article_id: glossArticleId, workspace_id: ctx.workspaceId, lang };
  const run = { task: "article_gloss", workspaceId: ctx.workspaceId, jobId: ctx.jobId, temperature: 0 };
  const save = async (rows: { kind: string; idx: number; content: unknown }[]) => {
    const r = await db().from("article_gloss").upsert(rows.map((x) => ({ ...base, ...x })), { onConflict: "article_id,lang,kind,idx" });
    if (r.error) throw new JobError("gloss save failed", "db_error", { retryable: true });
  };
  const need = <T,>(v: T | undefined): T => {
    if (v === undefined) throw new JobError("article section missing", "sections_incomplete", { retryable: false });
    return v;
  };

  if (part === "head") {
    if (!has("head", 0)) {
      const title = (await db().from("articles").select("title").eq("id", glossArticleId).maybeSingle()).data?.title;
      const p = G.headPrompt(lang, typeof title === "string" ? title : "", o.data.highlights);
      const r = await callLlm({ ...run, system: p.system, prompt: p.prompt, schema: G.headSchema, maxOutputTokens: 2000 });
      await save([{ kind: "head", idx: 0, content: r.data }]);
    }
  } else if (part === "intro") {
    if (!has("intro", 0)) {
      const p = G.paragraphsPrompt(lang, need(pick<IntroContent>(sec, "intro")).paragraphs);
      const r = await callLlm({ ...run, system: p.system, prompt: p.prompt, schema: G.paragraphsSchema, maxOutputTokens: 3000 });
      await save([{ kind: "intro", idx: 0, content: { paragraphs: r.data.paragraphs } }]);
    }
  } else if (part === "faq") {
    if (!has("faq", 0) || !has("conclusion", 0)) {
      const p = G.faqPrompt(lang, need(pick<FaqContent>(sec, "faq")), need(pick<ConclusionContent>(sec, "conclusion")));
      const r = await callLlm({ ...run, system: p.system, prompt: p.prompt, schema: G.faqSchema, maxOutputTokens: 5000 });
      await save([{ kind: "faq", idx: 0, content: { items: r.data.faq } }, { kind: "conclusion", idx: 0, content: { paragraphs: r.data.conclusion } }]);
    }
  } else {
    const from = Number(part.slice("items:".length));
    const to = Math.min(n, from + G.GLOSS_ITEMS_PER_JOB);
    const missing = Array.from({ length: to - from }, (_, k) => from + k).filter((i) => !has("item", i));
    if (missing.length > 0) {
      const p = G.itemsPrompt(lang, missing.map((i) => ({ i: i + 1, content: need(pick<ItemContent>(sec, "item", i)) })));
      const r = await callLlm({ ...run, system: p.system, prompt: p.prompt, schema: G.itemsSchema, maxOutputTokens: 9000 });
      const rows: { kind: string; idx: number; content: unknown }[] = [];
      for (const it of r.data) {
        const idx = it.i - 1;
        if (!missing.includes(idx) || rows.some((x) => x.idx === idx)) continue;
        rows.push({ kind: "item", idx, content: { heading: it.heading, paragraphs: it.paragraphs, bullets: it.bullets } });
      }
      await save(rows);
      if (rows.length < missing.length) throw new JobError("model skipped some items", "items_missing", { retryable: true, retryAfterSeconds: 2 });
    }
  }
  return { part, lang };
};

export const articleHandlers: Record<string, JobHandler> = {
  "article.outline": outlineJob,
  "article.sections": sectionsJob,
  "article.assemble": assembleJob,
  "article.review": reviewJob,
  "article.gloss": glossJob,
};
