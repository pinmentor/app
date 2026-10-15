"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin/guard";
import { jobActionSchema, testJobSchema } from "@/lib/admin/job-schemas";
import { canEnqueueTestJobs, canManageJobs } from "@/lib/admin/roles";
import { createAdminClient } from "@/lib/supabase/admin";

async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null;
}

function flashFor(code: string | undefined): string {
  if (code === "PM001") return "insufficient";
  if (code === "PM003") return "state";
  if (code === "42501") return "forbidden";
  return "error";
}

/** Retry a dead-letter job (re-reserves its credits). Guard: admin role + 2FA; the SQL re-checks the role and audits. */
export async function retryJob(formData: FormData) {
  const { user, role } = await requireAdmin();
  if (!canManageJobs(role)) redirect("/admin/jobs?flash=forbidden");
  const parsed = jobActionSchema.safeParse({ jobId: formData.get("jobId") });
  if (!parsed.success) redirect("/admin/jobs?flash=invalid");

  const { error } = await createAdminClient().rpc("admin_job_retry", {
    p_admin: user.id,
    p_job: parsed.data.jobId,
    p_ip: await clientIp(),
  });
  revalidatePath("/admin/jobs");
  if (error) {
    console.error("admin_job_retry failed", error.code);
    redirect(`/admin/jobs?flash=${flashFor(error.code)}`);
  }
  redirect("/admin/jobs?flash=retried");
}

/** Cancel a queued or dead job (releases its credit hold). */
export async function cancelJob(formData: FormData) {
  const { user, role } = await requireAdmin();
  if (!canManageJobs(role)) redirect("/admin/jobs?flash=forbidden");
  const parsed = jobActionSchema.safeParse({ jobId: formData.get("jobId") });
  if (!parsed.success) redirect("/admin/jobs?flash=invalid");

  const { error } = await createAdminClient().rpc("admin_job_cancel", {
    p_admin: user.id,
    p_job: parsed.data.jobId,
    p_ip: await clientIp(),
  });
  revalidatePath("/admin/jobs");
  if (error) {
    console.error("admin_job_cancel failed", error.code);
    redirect(`/admin/jobs?flash=${flashFor(error.code)}`);
  }
  redirect("/admin/jobs?flash=canceled");
}

/** Enqueue a plumbing-test job in the admin's OWN workspace (the SQL refuses any other workspace). */
export async function enqueueTestJob(formData: FormData) {
  const { user, role } = await requireAdmin();
  if (!canEnqueueTestJobs(role)) redirect("/admin/jobs?flash=forbidden");
  const parsed = testJobSchema.safeParse({ mode: formData.get("mode"), key: formData.get("key") });
  if (!parsed.success) redirect("/admin/jobs?flash=invalid");

  const sb = createAdminClient();
  const { data: ws } = await sb
    .from("workspaces")
    .select("id")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const workspaceId: unknown = ws?.id;
  if (typeof workspaceId !== "string") redirect("/admin/jobs?flash=error");

  const { error } = await sb.rpc("admin_enqueue_test_job", {
    p_admin: user.id,
    p_workspace: workspaceId,
    p_key: parsed.data.key,
    p_mode: parsed.data.mode,
    p_ip: await clientIp(),
  });
  revalidatePath("/admin/jobs");
  if (error) {
    console.error("admin_enqueue_test_job failed", error.code);
    redirect(`/admin/jobs?flash=${flashFor(error.code)}`);
  }
  redirect("/admin/jobs?flash=enqueued");
}
