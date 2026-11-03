"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin/guard";
import { canEnqueueTestJobs } from "@/lib/admin/roles";
import { createAdminClient } from "@/lib/supabase/admin";
import { z } from "zod";
import { parseKeywordInput } from "@/modules/keywords/csv";
import { languageOf, startRunSchema } from "./schemas";

const BASE = "/admin/maps";

async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null;
}

/** Starts a map run in the admin's OWN workspace; the SQL function refuses any other and writes admin_audit. */
export async function startRun(formData: FormData) {
  const { user, role } = await requireAdmin();
  if (!canEnqueueTestJobs(role)) redirect(`${BASE}?flash=forbidden`);
  const parsed = startRunSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`${BASE}?flash=invalid`);
  const v = parsed.data;

  const sb = createAdminClient();
  const { data: ws } = await sb.from("workspaces").select("id").eq("owner_id", user.id).order("created_at", { ascending: true }).limit(1).maybeSingle();
  const workspaceId: unknown = ws?.id;
  if (typeof workspaceId !== "string") redirect(`${BASE}?flash=error`);

  // With the user's own keywords (pasted and/or the saved library): "Expand + mine", or "Only my keywords" (skips S1-S2, needs 10+).
  const own = (v.ownKeywords ?? "").trim() !== "" || v.useLibrary === "on" || v.onlyMine === "on";
  if (own) {
    const only = v.onlyMine === "on";
    const seen = new Set<string>();
    const texts: string[] = [];
    for (const i of parseKeywordInput(v.ownKeywords ?? "", v.locale).items) {
      seen.add(i.normKey);
      texts.push(i.text);
    }
    if (v.useLibrary === "on") {
      const lib = await sb.from("keyword_library").select("text, norm_key").eq("workspace_id", workspaceId).eq("lang", languageOf(v.locale)).eq("kind", "keyword").order("created_at", { ascending: false }).limit(1000);
      const rows = z.array(z.object({ text: z.string(), norm_key: z.string() })).safeParse(lib.data ?? []);
      if (lib.error || !rows.success) redirect(`${BASE}?flash=error`);
      for (const r of rows.data) {
        if (seen.has(r.norm_key)) continue;
        seen.add(r.norm_key);
        texts.push(r.text);
      }
    }
    const keywords = texts.slice(0, 1000);
    if (keywords.length === 0 || (only && keywords.length < 10)) redirect(`${BASE}?flash=need_keywords`);
    const res = await sb.rpc("admin_map_run_create_own", {
      p_admin: user.id,
      p_workspace: workspaceId,
      p_topic: v.topic,
      p_language: languageOf(v.locale),
      p_locale: v.locale,
      p_only_mine: only,
      p_size: only ? "custom" : v.size,
      p_target_min: only ? 10 : v.targetMin,
      p_target_max: only ? Math.min(1000, Math.max(10, keywords.length)) : v.targetMax,
      p_mode: v.mode,
      p_key: v.key,
      p_keywords: keywords,
      p_ip: await clientIp(),
    });
    revalidatePath(BASE);
    if (res.error) {
      console.error("admin_map_run_create_own failed", res.error.code ?? "no_code");
      redirect(`${BASE}?flash=${res.error.code === "PM001" ? "no_credits" : res.error.code === "42501" ? "forbidden" : res.error.code === "22023" ? "invalid" : "error"}`);
    }
    redirect(`${BASE}?flash=started`);
  }

  const { error } = await sb.rpc("admin_map_run_create_sized", {
    p_admin: user.id,
    p_workspace: workspaceId,
    p_topic: v.topic,
    p_language: languageOf(v.locale),
    p_locale: v.locale,
    p_size: v.size,
    p_target_min: v.targetMin,
    p_target_max: v.targetMax,
    p_mode: v.mode,
    p_key: v.key,
    p_ip: await clientIp(),
  });
  revalidatePath(BASE);
  if (error) {
    console.error("admin_map_run_create_sized failed", error.code ?? "no_code");
    redirect(`${BASE}?flash=${error.code === "PM001" ? "no_credits" : error.code === "42501" ? "forbidden" : error.code === "22023" ? "invalid" : "error"}`);
  }
  redirect(`${BASE}?flash=started`);
}

/** Cancels a run (releases its credit hold). Only the owner of the run's workspace, i.e. the admin's own runs. */
export async function cancelRun(formData: FormData) {
  const { user, role } = await requireAdmin();
  if (!canEnqueueTestJobs(role)) redirect(`${BASE}?flash=forbidden`);
  const id = String(formData.get("id") ?? "");
  if (!/^[0-9a-f-]{36}$/.test(id)) redirect(`${BASE}?flash=invalid`);
  const { error } = await createAdminClient().rpc("map_run_cancel", { p_run: id, p_user: user.id });
  revalidatePath(BASE);
  if (error) {
    console.error("map_run_cancel failed", error.code ?? "no_code");
    redirect(`${BASE}?flash=${error.code === "42501" ? "forbidden" : "error"}`);
  }
  redirect(`${BASE}?flash=canceled`);
}
