import { z } from "zod";
import { JobError, type JobHandler } from "@/modules/jobs/types";
import { db, parsePayload, uuid } from "@/modules/topical-map/stage-kit";
import { sendArticle, type SendMode } from "./send";

const MAX_ATTEMPTS = 3; // must match job_enqueue in articles_wp_enqueue (0025)
const payload = z.object({ wpArticleId: uuid, userId: uuid, mode: z.enum(["draft", "publish", "future"]), when: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).nullish() });

/** Background send of ONE article (draft / publish / schedule). The last failure is written to articles.wp_error so the owner sees why. */
const wpSendJob: JobHandler = async (ctx) => {
  const p = parsePayload(payload, ctx.payload);
  const mode: SendMode = p.mode === "future" ? { kind: "future", when: p.when ?? "" } : p.mode === "publish" ? { kind: "publish" } : { kind: "draft" };
  if (mode.kind === "future" && !mode.when) throw new JobError("schedule time missing", "invalid_payload", { retryable: false });

  const r = await sendArticle(db(), p.userId, p.wpArticleId, mode);
  if (r.ok) {
    await db().from("articles").update({ wp_error: null }).eq("id", p.wpArticleId);
    return { status: r.status, schemaKept: r.schemaKept };
  }
  const last = !r.retryable || ctx.attempt >= MAX_ATTEMPTS;
  if (last) await db().from("articles").update({ wp_error: r.code.slice(0, 120) }).eq("id", p.wpArticleId);
  throw new JobError(`wordpress send failed: ${r.code}`, r.code.slice(0, 60), { retryable: r.retryable, retryAfterSeconds: 30 });
};

export const wordpressHandlers: Record<string, JobHandler> = { "wp.send": wpSendJob };
