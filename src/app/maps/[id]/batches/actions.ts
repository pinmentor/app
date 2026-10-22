"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { parseAutoForm, parseBatchAction, parseManualForm } from "@/modules/topical-map/batching";
import { runFlash } from "@/modules/articles/progress";
import { loadMap, suggestFor } from "../load";

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
