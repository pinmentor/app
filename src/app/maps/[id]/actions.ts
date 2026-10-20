"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { parseEditForm, parseReviewForm, statusForIntent } from "@/modules/topical-map/review-view";

/**
 * Approve / reject / back to draft for the items of one map. The user is authenticated here (session); the SQL
 * function re-checks membership, the finished-run and not-red-report rules, so the rules do not depend on this code.
 */
export async function reviewItems(formData: FormData) {
  const form = parseReviewForm(formData);
  const back = (flash: string) => `/maps/${form?.run ?? ""}?gloss=${form?.gloss ?? "off"}&flash=${flash}`;
  if (!form) redirect("/maps");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/maps/${form.run}`)}`);

  const sb = createAdminClient();
  const res =
    form.intent === "approve_clean"
      ? await sb.rpc("plan_items_approve_clean", { p_user: user.id, p_run: form.run })
      : await sb.rpc("plan_items_set_status", { p_user: user.id, p_run: form.run, p_ids: form.ids, p_status: statusForIntent(form.intent) });

  revalidatePath(`/maps/${form.run}`);
  if (res.error) {
    console.error("plan review failed", res.error.code ?? "no_code");
    redirect(back(res.error.code === "PM003" ? "blocked" : res.error.code === "42501" || res.error.code === "PM004" ? "forbidden" : "error"));
  }
  redirect(back(`done-${typeof res.data === "number" ? res.data : 0}`));
}

/**
 * Merge two items, move items to another silo, split a variant out of an item. Same pattern as reviewItems: the user is
 * authenticated here, the SQL functions re-check membership, finished run, approved items and pillars.
 */
export async function editItems(formData: FormData) {
  const form = parseEditForm(formData);
  const back = (flash: string) => `/maps/${form?.run ?? ""}?gloss=${form?.gloss ?? "off"}&flash=${flash}`;
  if (!form) {
    const run = String(formData.get("run") ?? "");
    redirect(/^[0-9a-f-]{36}$/i.test(run) ? `/maps/${run}?flash=pick` : "/maps");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/maps/${form.run}`)}`);

  const sb = createAdminClient();
  const res =
    form.intent === "merge"
      ? await sb.rpc("plan_item_merge", { p_user: user.id, p_run: form.run, p_keep: form.ids[0], p_drop: form.ids[1] })
      : form.intent === "move"
        ? await sb.rpc("plan_items_move", { p_user: user.id, p_run: form.run, p_ids: form.ids, p_silo: form.silo })
        : await sb.rpc("plan_item_split", { p_user: user.id, p_run: form.run, p_item: form.item, p_variant: form.variant });

  revalidatePath(`/maps/${form.run}`);
  if (res.error) {
    const code = res.error.code ?? "no_code";
    console.error("plan edit failed", form.intent, code);
    redirect(back(code === "PM003" ? "locked" : code === "42501" ? "forbidden" : code === "PM004" ? "gone" : code === "22023" ? "pick" : "error"));
  }
  redirect(back(`edited-${form.intent}`));
}
