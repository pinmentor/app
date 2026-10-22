import { z } from "zod";
import { callLlm } from "@/modules/llm/client";
import { JobError, type JobContext, type JobHandler } from "@/modules/jobs/types";
import { db, enqueue, LOCALES, parsePayload, rpc, uuid } from "@/modules/topical-map/stage-kit";
import {
  faqPrompt, faqSchema, introPrompt, introSchema, itemsPrompt, itemsSchema, ITEMS_PER_JOB, outlinePrompt, outlineSchema, storedOutlineSchema, wordsPerItem,
  type ConclusionContent, type FaqContent, type IntroContent, type ItemContent, type StoredOutline,
} from "./prompts";
import { renderArticle, countWords, plainText, type ArticleParts } from "./render";
import { qaArticle } from "./qa";

/**
 * Article writer v1 (Type A). Three kinds of short, idempotent jobs, all keyed by article id:
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
const assembleJob: JobHandler = guarded(async (ctx) => {
  const { articleId } = parsePayload(articlePayload, ctx.payload);
  const l = await load(ctx, articleId);
  if (!l) return { skipped: "final" };
  const o = storedOutline(l);
  const r = await db().from("article_sections").select("kind, idx, content").eq("article_id", articleId).order("idx");
  if (r.error) throw new JobError("sections read failed", "db_error", { retryable: true });
  const rows = (r.data ?? []) as { kind: string; idx: number; content: unknown }[];
  const get = <T,>(kind: string, idx = 0) => rows.find((x) => x.kind === kind && x.idx === idx)?.content as T | undefined;

  const intro = get<IntroContent>("intro");
  const faq = get<FaqContent>("faq");
  const conclusion = get<ConclusionContent>("conclusion");
  const items = Array.from({ length: o.n }, (_, i) => get<ItemContent>("item", i));
  if (!intro || !faq || !conclusion || items.some((x) => !x)) throw new JobError("sections incomplete", "sections_incomplete", { retryable: true, retryAfterSeconds: 5 });

  const parts: ArticleParts = { title: l.item.title ?? l.art.keyword, locale: l.art.locale, highlights: o.highlights, intro, items: items as ItemContent[], faq, conclusion };
  const html = renderArticle(parts);
  const qa = qaArticle(parts, l.item.slug, o.n, l.item.target_words);
  const words = countWords(plainText(parts));
  await rpc("article_finish", {
    p_article: articleId,
    p_status: "ready",
    p_error: null,
    p_patch: { title: parts.title, slug: l.item.slug, body_html: html, word_count: words, qa, stats: { qa_verdict: qa.verdict, items: o.n } },
  });
  return { words, qa: qa.verdict };
});

export const articleHandlers: Record<string, JobHandler> = {
  "article.outline": outlineJob,
  "article.sections": sectionsJob,
  "article.assemble": assembleJob,
};
