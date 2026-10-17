/** Roles that may open /admin (profiles.role). `user` is the normal customer role and has no admin access. */
export const ADMIN_ROLES = ["superadmin", "support", "finance", "analyst"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === "string" && (ADMIN_ROLES as readonly string[]).includes(value);
}

/** Manual credit grants/revokes: superadmin only in this batch (PLAN §10.1 "support: limited" is a later decision). */
export function canAdjustCredits(role: AdminRole): boolean {
  return role === "superadmin";
}

/** Retry / cancel dead-letter jobs (PLAN §10.1: support may retry). */
export function canManageJobs(role: AdminRole): boolean {
  return role === "superadmin" || role === "support";
}

/** Enqueue test jobs: they spend the admin's own workspace credits, so superadmin only. */
export function canEnqueueTestJobs(role: AdminRole): boolean {
  return role === "superadmin";
}

/** Add, replace, test and remove platform API keys: superadmin only (they spend the platform's money). */
export function canManageSecrets(role: AdminRole): boolean {
  return role === "superadmin";
}
