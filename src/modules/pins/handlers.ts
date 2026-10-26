import { z } from "zod";
import { callLlm } from "@/modules/llm/client";
import { JobError, type JobHandler } from "@/modules/jobs/types";
import { storedOutlineSchema } from "@/modules/articles/prompts";
import { db, LOCALES, parsePayload, uuid } from "@/modules/topical-map/stage-kit";
import { checkPins, DEFAULT_PINS, pinPrompt, pinSchema } from "./copy";

const payload = z.object({ pinArticleId: uuid, count: z.number().int().min(1).max(10).default(DEFAULT_PINS) });

/** One job writes the pin texts of one ready article (a single LLM call, well under 60 s) and stores them as drafts. Idempotent: pins that exist are kept. */
const pinCopyJob: JobHandler = async (ctx) => {
  const { pinArticleId, count } = parsePayload(payload, ctx.payload);
  const a = await db().from("articles").select("id, workspace_id, status, title, keyword, locale, outline, meta_description").eq("id", pinArticleId).eq("workspace_id", ctx.workspaceId).maybeSingle();
  if (a.error) throw new JobError("article lookup failed", "db_error", { retryable: true });
  if (!a.data || a.data.status !== "ready") return { skipped: "not_ready" };
  const locale = z.enum(LOCALES).safeParse(a.data.locale);
  const o = storedOutlineSchema.safeParse(a.data.outline);
  if (!locale.success || !o.success || typeof a.data.title !== "string") throw new JobError("article data incomplete", "article_incomplete", { retryable: false });

  const have = await db().from("pins").select("position").eq("article_id", pinArticleId);
  if (have.error) throw new JobError("pins read failed", "db_error", { retryable: true });
  if ((have.data ?? []).length > 0) return { skipped: "pins_exist" };

  const p = pinPrompt({ title: a.data.title, keyword: a.data.keyword, locale: locale.data, meta: typeof a.data.meta_description === "string" ? a.data.meta_description : null, headings: o.data.items.map((i) => i.heading), highlights: o.data.highlights }, count);
  const r = await callLlm({ task: "pin_copy", workspaceId: ctx.workspaceId, jobId: ctx.jobId, system: p.system, prompt: p.prompt, schema: pinSchema, maxOutputTokens: 4000, temperature: 0.8 });
  const pins = r.data.slice(0, count);
  const checks = checkPins(pins, a.data.title);
  const rows = pins.map((x, i) => ({
    workspace_id: ctx.workspaceId, article_id: pinArticleId, position: i + 1, angle: x.angle.slice(0, 160),
    title: x.title.slice(0, 100), description: x.description.slice(0, 500), alt: x.alt.slice(0, 500), keywords: x.keywords,
    gloss_bn: x.gloss_bn || null, checks: checks[i], status: "draft",
  }));
  const up = await db().from("pins").upsert(rows, { onConflict: "article_id,position", ignoreDuplicates: true });
  if (up.error) throw new JobError("pins save failed", "db_error", { retryable: true });
  return { pins: rows.length, asked: count, flagged: checks.filter((c) => c.status === "flag").length };
};

export const pinHandlers: Record<string, JobHandler> = { "pin.copy": pinCopyJob };
