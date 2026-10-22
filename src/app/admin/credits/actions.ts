"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin/guard";
import { canManageRates } from "@/lib/admin/roles";
import { parseRateAction, parseRateForm } from "@/lib/admin/credit-rates";
import { createAdminClient } from "@/lib/supabase/admin";

const BASE = "/admin/credits";

async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null;
}

const go = (flash: string, action?: string): never => {
  const q = new URLSearchParams({ flash });
  if (action && /^[a-z][a-z0-9_.]{1,63}$/.test(action)) q.set("a", action);
  redirect(`${BASE}?${q.toString()}`);
};

/** Sets (or changes) the price of one action. The number comes from the superadmin's form; nothing here picks a price. */
export async function setRate(formData: FormData) {
  const { user, role } = await requireAdmin();
  if (!canManageRates(role)) return go("forbidden");
  const f = parseRateForm(Object.fromEntries(formData));
  if (!f) return go("invalid");
  const { error } = await createAdminClient().rpc("admin_credit_rate_set", {
    p_admin: user.id, p_action: f.action, p_credits: f.credits, p_note: f.note, p_ip: await clientIp(),
  });
  if (error) {
    console.error("admin_credit_rate_set failed", error.code ?? "no_code");
    return go(error.code === "42501" ? "forbidden" : "error", f.action);
  }
  revalidatePath(BASE);
  return go("saved", f.action);
}

/** Removes a price. For article_write this makes batch runs refuse again (PM005) until a new price is set. */
export async function removeRate(formData: FormData) {
  const { user, role } = await requireAdmin();
  if (!canManageRates(role)) return go("forbidden");
  const action = parseRateAction(formData.get("action"));
  if (!action) return go("invalid");
  const { data, error } = await createAdminClient().rpc("admin_credit_rate_delete", { p_admin: user.id, p_action: action, p_ip: await clientIp() });
  if (error) {
    console.error("admin_credit_rate_delete failed", error.code ?? "no_code");
    return go(error.code === "42501" ? "forbidden" : error.code === "22023" ? "protected" : "error", action);
  }
  revalidatePath(BASE);
  return go(z.boolean().safeParse(data).data === false ? "nothing_to_remove" : "removed", action);
}
