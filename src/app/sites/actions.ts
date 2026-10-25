"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { testSite } from "@/modules/wordpress/client";
import { cleanAppPassword, decryptSitePassword, encryptSitePassword } from "@/modules/wordpress/secret";
import { normalizeSiteUrl } from "@/modules/wordpress/url";

/**
 * Connect / test / remove a WordPress site. The user is authenticated here (session); the SQL functions of 0021 re-check
 * membership. The Application Password is encrypted before it reaches the database and is never put in a redirect, log or message.
 */
async function me() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=%2Fsites");
  const m = await supabase.from("workspace_members").select("workspace_id").eq("user_id", user.id).limit(1).maybeSingle();
  const ws = z.string().uuid().safeParse(m.data?.workspace_id);
  return { userId: user.id, workspaceId: ws.success ? ws.data : null };
}

const connectForm = z.object({ address: z.string().min(3).max(300), user: z.string().trim().min(1).max(100), password: z.string().min(8).max(200) });

export async function connectSite(formData: FormData) {
  const { userId, workspaceId } = await me();
  const f = connectForm.safeParse({ address: formData.get("address"), user: formData.get("user"), password: formData.get("password") });
  if (!f.success || !workspaceId) redirect("/sites?flash=invalid");
  const url = normalizeSiteUrl(f.data.address);
  if (!url) redirect("/sites?flash=bad_address");
  const password = cleanAppPassword(f.data.password);

  let blob: string;
  try {
    blob = encryptSitePassword(workspaceId, url, password);
  } catch {
    redirect("/sites?flash=no_master_key");
  }
  const sb = createAdminClient();
  const saved = await sb.rpc("site_connect", { p_user: userId, p_workspace: workspaceId, p_name: new URL(url).hostname.slice(0, 80), p_base_url: url, p_wp_user: f.data.user, p_ciphertext: blob, p_last4: password.slice(-4) });
  const id = z.string().uuid().safeParse(saved.data);
  if (saved.error || !id.success) {
    console.error("site connect failed", saved.error?.code ?? "no_code");
    redirect(`/sites?flash=${saved.error?.code === "22023" ? "limit" : "error"}`);
  }
  const t = await testSite({ baseUrl: url, user: f.data.user, password });
  await sb.rpc("site_record_test", { p_user: userId, p_site: id.data, p_ok: t.ok, p_code: t.code });
  revalidatePath("/sites");
  redirect(`/sites?flash=${t.ok ? "connected" : "failed"}&code=${encodeURIComponent(t.code)}`);
}

const idForm = z.object({ site: z.string().uuid() });

export async function retestSite(formData: FormData) {
  const { userId } = await me();
  const f = idForm.safeParse({ site: formData.get("site") });
  if (!f.success) redirect("/sites");
  const sb = createAdminClient();
  const row = await sb.from("sites").select("workspace_id, base_url, wp_user, ciphertext").eq("id", f.data.site).maybeSingle();
  const r = z.object({ workspace_id: z.string().uuid(), base_url: z.string(), wp_user: z.string(), ciphertext: z.string() }).safeParse(row.data);
  if (!r.success) redirect("/sites?flash=error");
  const member = await sb.from("workspace_members").select("user_id").eq("workspace_id", r.data.workspace_id).eq("user_id", userId).maybeSingle();
  if (!member.data) redirect("/sites?flash=error");
  let password: string;
  try {
    password = decryptSitePassword(r.data.workspace_id, r.data.base_url, r.data.ciphertext);
  } catch {
    redirect("/sites?flash=no_master_key");
  }
  const t = await testSite({ baseUrl: r.data.base_url, user: r.data.wp_user, password });
  await sb.rpc("site_record_test", { p_user: userId, p_site: f.data.site, p_ok: t.ok, p_code: t.code });
  revalidatePath("/sites");
  redirect(`/sites?flash=${t.ok ? "connected" : "failed"}&code=${encodeURIComponent(t.code)}`);
}

export async function removeSite(formData: FormData) {
  const { userId } = await me();
  const f = idForm.safeParse({ site: formData.get("site") });
  if (!f.success) redirect("/sites");
  const res = await createAdminClient().rpc("site_delete", { p_user: userId, p_site: f.data.site });
  revalidatePath("/sites");
  redirect(`/sites?flash=${res.error ? "error" : "removed"}`);
}
