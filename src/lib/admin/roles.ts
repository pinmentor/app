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
