"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { parseReviewForm, statusForIntent } from "@/modules/topical-map/review-view";

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
