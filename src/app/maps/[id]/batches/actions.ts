"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { parseAutoForm, parseBatchAction, parseManualForm } from "@/modules/topical-map/batching";
import { runFlash } from "@/modules/articles/progress";
import { loadMap, suggestFor } from "../load";
import { planSchedule, validDate } from "@/modules/wordpress/schedule";
import { z } from "zod";

/**
 * Batch actions. Same pattern as the review actions: the user is authenticated here (session); the SQL functions (0016)
 * re-check membership, finished run, approved items and batch state, so the rules do not depend on this code.
 * The auto suggestion is recomputed here from the database (never taken from the browser).
 */
async function authed(run: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/maps/${run}/batches`)}`);
  return { supabase, user };
}

function flashFor(err: { code?: string; message?: string }): string {
  const code = err.code ?? "no_code";
  return code === "PM003" ? "locked" : code === "42501" ? "forbidden" : code === "PM004" ? "gone" : code === "22023" ? "pick" : "error";
}

export async function createAutoBatches(formData: FormData) {
  const form = parseAutoForm(formData);
  const run = String(formData.get("run") ?? "");
  if (!form) redirect(/^[0-9a-f-]{36}$/i.test(run) ? `/maps/${run}/batches?flash=pick` : "/maps");
  const back = (flash: string) => `/maps/${form.run}/batches?size=${form.size}&flash=${flash}`;
  const { supabase, user } = await authed(form.run);

  const map = await loadMap(supabase, form.run);
  if (!map) redirect(back("gone"));
  let suggestions = suggestFor(map, form.size);
  if (form.intent === "next") {
    const first = suggestions.find((b) => b.siloId === form.silo);
    suggestions = first ? [first] : [];
  }
  if (suggestions.length === 0) redirect(back("nothing"));

  const res = await createAdminClient().rpc("batches_create", {
    p_user: user.id,
    p_run: form.run,
    p_batches: suggestions.map((b) => ({ name: b.name, item_ids: b.itemIds })),
    p_origin: "auto",
  });
  revalidatePath(`/maps/${form.run}/batches`);
  revalidatePath(`/maps/${form.run}/dashboard`);
  if (res.error) {
    console.error("batch create failed", res.error.code ?? "no_code");
    redirect(back(flashFor(res.error)));
  }
  redirect(back(`created-${Array.isArray(res.data) ? res.data.length : 0}`));
}

export async function createManualBatch(formData: FormData) {
  const form = parseManualForm(formData);
  const run = String(formData.get("run") ?? "");
  if (!form) redirect(/^[0-9a-f-]{36}$/i.test(run) ? `/maps/${run}/batches?flash=pick` : "/maps");
  const { user } = await authed(form.run);

  const res = await createAdminClient().rpc("batches_create", {
    p_user: user.id,
    p_run: form.run,
    p_batches: [{ name: form.name, item_ids: form.ids }],
    p_origin: "manual",
  });
  revalidatePath(`/maps/${form.run}/batches`);
  revalidatePath(`/maps/${form.run}/dashboard`);
  if (res.error) {
    console.error("manual batch failed", res.error.code ?? "no_code");
    redirect(`/maps/${form.run}/batches?flash=${flashFor(res.error)}`);
  }
  redirect(`/maps/${form.run}/batches?flash=created-1`);
}

export async function changeBatch(formData: FormData) {
  const form = parseBatchAction(formData);
  const run = String(formData.get("run") ?? "");
  if (!form) redirect(/^[0-9a-f-]{36}$/i.test(run) ? `/maps/${run}/batches?flash=pick` : "/maps");
  const { user } = await authed(form.run);

  const sb = createAdminClient();
  const res =
    form.intent === "cancel"
      ? await sb.rpc("batch_cancel", { p_user: user.id, p_batch: form.batch })
      : await sb.rpc("batch_remove_items", { p_user: user.id, p_batch: form.batch, p_ids: form.ids });
  revalidatePath(`/maps/${form.run}/batches`);
  revalidatePath(`/maps/${form.run}/dashboard`);
  if (res.error) {
    console.error("batch change failed", form.intent, res.error.code ?? "no_code");
    redirect(`/maps/${form.run}/batches?flash=${flashFor(res.error)}`);
  }
  redirect(`/maps/${form.run}/batches?flash=${form.intent === "cancel" ? "canceled" : "removed"}-${typeof res.data === "number" ? res.data : 0}`);
}

const UUID = /^[0-9a-f-]{36}$/i;
/** run + batch ids from a run/stop form, or a redirect back when they are not ids. */
function runIds(fd: FormData): { run: string; batch: string } {
  const run = String(fd.get("run") ?? "");
  const batch = String(fd.get("batch") ?? "");
  if (!UUID.test(run)) redirect("/maps");
  if (!UUID.test(batch)) redirect(`/maps/${run}/batches?flash=pick`);
  return { run, batch };
}

/**
 * Start writing a planned batch: the SQL (0018) checks membership, state, Type A + title, that a price is set (PM005),
 * and holds price x articles from the credit balance (PM001 when it is not enough). The price is read there, never here.
 */
export async function runBatch(formData: FormData) {
  const { run, batch } = runIds(formData);
  const { user } = await authed(run);
  const res = await createAdminClient().rpc("batch_run_start", { p_user: user.id, p_batch: batch });
  revalidatePath(`/maps/${run}/batches`);
  revalidatePath(`/maps/${run}/dashboard`);
  if (res.error) {
    console.error("batch run failed", res.error.code ?? "no_code");
    redirect(`/maps/${run}/batches?flash=${runFlash(res.error.code)}`);
  }
  redirect(`/maps/${run}/batches?flash=started-${typeof res.data === "number" ? res.data : 0}`);
}

/** Stop a running batch: unfinished articles are cancelled (free, their items are approved again); finished ones stay and are charged. */
export async function stopBatch(formData: FormData) {
  const { run, batch } = runIds(formData);
  const { user } = await authed(run);
  const res = await createAdminClient().rpc("batch_run_cancel", { p_user: user.id, p_batch: batch });
  revalidatePath(`/maps/${run}/batches`);
  revalidatePath(`/maps/${run}/dashboard`);
  if (res.error) {
    console.error("batch stop failed", res.error.code ?? "no_code");
    redirect(`/maps/${run}/batches?flash=${runFlash(res.error.code)}`);
  }
  redirect(`/maps/${run}/batches?flash=stopped-${typeof res.data === "number" ? res.data : 0}`);
}

// ---------------------------------------------------------------------------
// Send a whole batch to WordPress in the background (Batch 21): all as drafts, or published gradually (N per day in a time window).
// One wp.send job per article; the SQL function (0025) re-checks membership and that every article is ready and in this batch.
// Red articles (QA fail) are never queued for publishing; articles already published or scheduled are left alone.
// ---------------------------------------------------------------------------
const bulkForm = z.object({
  run: z.string().uuid(), batch: z.string().uuid(), plan: z.enum(["drafts", "spread"]),
  start: z.string().optional(), per_day: z.coerce.number().int().min(1).max(10).optional(),
  from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), until: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
});

export async function sendBatchToWordPress(formData: FormData) {
  const run = String(formData.get("run") ?? "");
  const f = bulkForm.safeParse({ run, batch: formData.get("batch"), plan: formData.get("plan"), start: formData.get("start") || undefined, per_day: formData.get("per_day") || undefined, from: formData.get("from") || undefined, until: formData.get("until") || undefined });
  if (!f.success) redirect(/^[0-9a-f-]{36}$/i.test(run) ? `/maps/${run}/batches?flash=wp_invalid` : "/maps");
  const back = (flash: string) => `/maps/${f.data.run}/batches?flash=${flash}`;
  const { supabase, user } = await authed(f.data.run);

  const map = await loadMap(supabase, f.data.run);
  if (!map) redirect(back("gone"));
  const posOf = new Map(map.items.map((i) => [i.id, i.position]));
  const wp = await supabase.from("articles").select("id, wp_status").eq("map_run_id", f.data.run).eq("batch_id", f.data.batch);
  const wpStatus = new Map(((wp.data ?? []) as { id: string; wp_status: string | null }[]).map((x) => [x.id, x.wp_status]));
  const ready = map.articles.filter((a) => a.batch_id === f.data.batch && a.status === "ready").sort((x, y) => (posOf.get(x.plan_item_id) ?? 0) - (posOf.get(y.plan_item_id) ?? 0));
  const spread = f.data.plan === "spread";
  const eligible = ready.filter((a) => {
    const s = wpStatus.get(a.id) ?? null;
    return spread ? a.qa.verdict !== "fail" && (s === null || s === "draft") : s === null;
  });
  const skipped = ready.length - eligible.length;
  if (eligible.length === 0) redirect(back(`wp_none-${skipped}`));

  let items: { article_id: string; mode: string; when?: string }[];
  if (spread) {
    const start = f.data.start ?? "";
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    if (!validDate(start) || start < yesterday) redirect(back("wp_date"));
    const plan = planSchedule({ count: eligible.length, startDate: start, perDay: f.data.per_day ?? 3, from: f.data.from ?? "09:00", until: f.data.until ?? "18:00" });
    if (!plan.ok) redirect(back(plan.error === "window_short" ? "wp_window" : "wp_invalid"));
    items = eligible.map((a, i) => ({ article_id: a.id, mode: "future", when: plan.times[i] }));
  } else {
    items = eligible.map((a) => ({ article_id: a.id, mode: "draft" }));
  }
  const res = await createAdminClient().rpc("articles_wp_enqueue", { p_user: user.id, p_batch: f.data.batch, p_items: items });
  revalidatePath(`/maps/${f.data.run}/batches`);
  if (res.error) {
    console.error("bulk wordpress enqueue failed", res.error.code ?? "no_code");
    redirect(back(flashFor(res.error)));
  }
  redirect(back(`wp_queued-${items.length}-${skipped}`));
}
