"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { LANGUAGES } from "@/lib/languages";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { MAX_BYTES, parseKeywordInput } from "@/modules/keywords/csv";

/**
 * Save keywords to the workspace library (pasted or uploaded). The user is authenticated here; keywords_import (0027)
 * re-checks membership and every limit. Nothing is spent: the library is free, only starting a map costs credits.
 */
async function me() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=%2Fkeywords");
  const m = await supabase.from("workspace_members").select("workspace_id").eq("user_id", user.id).limit(1).maybeSingle();
  const ws = z.string().uuid().safeParse(m.data?.workspace_id);
  return { userId: user.id, workspaceId: ws.success ? ws.data : null };
}

const importForm = z.object({
  lang: z.enum(LANGUAGES.map((l) => l.code) as [string, ...string[]]),
  text: z.string().max(MAX_BYTES),
  tags: z.string().max(300),
});
const resultSchema = z.object({ added: z.number(), duplicates: z.number(), invalid: z.number() });

export async function importKeywords(formData: FormData) {
  const { userId, workspaceId } = await me();
  const f = importForm.safeParse({ lang: formData.get("lang"), text: String(formData.get("text") ?? ""), tags: String(formData.get("tags") ?? "") });
  if (!f.success || !workspaceId) redirect("/keywords?flash=invalid");
  const file = formData.get("file");
  let source: "manual" | "csv" = "manual";
  let text = f.data.text;
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_BYTES) redirect("/keywords?flash=too_big");
    text = await file.text();
    source = "csv";
  }
  const locale = LANGUAGES.find((l) => l.code === f.data.lang)?.locale ?? "es-MX";
  const parsed = parseKeywordInput(text, locale);
  if (parsed.items.length === 0) redirect(`/keywords?flash=nothing&bad=${parsed.rejected.length}`);

  const extra = f.data.tags.split(",").map((t) => t.trim().slice(0, 40)).filter(Boolean).slice(0, 5);
  const items = parsed.items.map((i) => ({ text: i.text, norm_key: i.normKey, tags: [...new Set([...i.tags, ...extra])].slice(0, 10) }));
  const res = await createAdminClient().rpc("keywords_import", { p_user: userId, p_workspace: workspaceId, p_lang: f.data.lang, p_kind: "keyword", p_source: source, p_site: null, p_items: items });
  const out = resultSchema.safeParse(res.data);
  if (res.error || !out.success) {
    console.error("keywords import failed", res.error?.code ?? "no_code");
    redirect(`/keywords?flash=${res.error?.code === "54000" ? "full" : "error"}`);
  }
  revalidatePath("/keywords");
  const why = parsed.rejected.slice(0, 5).map((r) => `${r.line}.${r.reason}`).join(",");
  const q = new URLSearchParams({ flash: "imported", added: String(out.data.added), dup: String(out.data.duplicates + parsed.duplicatesInFile), bad: String(parsed.rejected.length + out.data.invalid), why, cut: parsed.truncated ? "1" : "" });
  redirect(`/keywords?${q.toString()}`);
}

const deleteForm = z.array(z.string().uuid()).min(1).max(1000);

export async function deleteKeywords(formData: FormData) {
  const { userId, workspaceId } = await me();
  const ids = deleteForm.safeParse(formData.getAll("id").map(String));
  if (!ids.success || !workspaceId) redirect("/keywords?flash=pick");
  const res = await createAdminClient().rpc("keywords_delete", { p_user: userId, p_workspace: workspaceId, p_ids: ids.data });
  if (res.error) console.error("keywords delete failed", res.error.code ?? "no_code");
  revalidatePath("/keywords");
  redirect(`/keywords?flash=${res.error ? "error" : "deleted"}&n=${typeof res.data === "number" ? res.data : 0}`);
}
