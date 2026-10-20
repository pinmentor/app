"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin/guard";
import { canEnqueueTestJobs } from "@/lib/admin/roles";
import { createAdminClient } from "@/lib/supabase/admin";
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
