"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const form = z.object({ lang: z.enum(["bn", "en"]) });

/** Workspace-wide default translation for review screens. Only an owner/admin of the workspace may change it (checked again in SQL, 0026). */
export async function setReviewLanguage(formData: FormData) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=%2Fsettings");
  const f = form.safeParse({ lang: formData.get("lang") });
  if (!f.success) redirect("/settings?flash=invalid");
  const m = await supabase.from("workspace_members").select("workspace_id").eq("user_id", user.id).limit(1).maybeSingle();
  const ws = z.string().uuid().safeParse(m.data?.workspace_id);
  if (!ws.success) redirect("/settings?flash=error");
  const res = await createAdminClient().rpc("workspace_set_review_language", { p_user: user.id, p_workspace: ws.data, p_lang: f.data.lang });
  if (res.error) console.error("review language failed", res.error.code ?? "no_code");
  revalidatePath("/settings");
  redirect(`/settings?flash=${res.error ? (res.error.code === "42501" ? "forbidden" : "error") : "saved"}`);
}
