"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin/guard";
import { canAdjustCredits } from "@/lib/admin/roles";
import { creditAdjustSchema } from "@/lib/admin/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Manual credit grant/revoke. Guard order: signed in + admin role + 2FA (aal2) + superadmin.
 * The SQL function re-checks superadmin, writes ledger + admin_audit atomically and is idempotent.
 */
export async function adjustCredits(formData: FormData) {
  const { user, role } = await requireAdmin();
  if (!canAdjustCredits(role)) redirect("/admin/users?flash=forbidden");

  const parsed = creditAdjustSchema.safeParse({
    workspaceId: formData.get("workspaceId"),
    delta: formData.get("delta"),
    reason: formData.get("reason"),
    key: formData.get("key"),
  });
  if (!parsed.success) redirect("/admin/users?flash=invalid");

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null;

  const { error } = await createAdminClient().rpc("admin_credit_adjust", {
    p_admin: user.id,
    p_workspace: parsed.data.workspaceId,
    p_delta: parsed.data.delta,
    p_reason: parsed.data.reason,
    p_key: parsed.data.key,
    p_ip: ip,
  });

  revalidatePath("/admin/users");
  if (error) {
    console.error("adjustCredits failed", error.code);
    redirect(`/admin/users?flash=${error.code === "PM001" ? "insufficient" : "error"}`);
  }
  redirect("/admin/users?flash=ok");
}
