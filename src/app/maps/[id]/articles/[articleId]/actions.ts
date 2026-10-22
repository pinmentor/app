"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

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
