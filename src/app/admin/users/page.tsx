import Link from "next/link";
import { z } from "zod";
import { AdminShell } from "@/app/admin/admin-nav";
import { requireAdmin } from "@/lib/admin/guard";
import { newIdempotencyKey } from "@/lib/admin/keys";
import { canAdjustCredits } from "@/lib/admin/roles";
import { userOverviewRowSchema } from "@/lib/admin/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { adjustCredits } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users — PinMentor Admin" };

const PAGE_SIZE = 25;

const FLASH: Record<string, { text: string; ok: boolean }> = {
  ok: { text: "Credits updated and logged in the audit trail.", ok: true },
  invalid: { text: "Check the amount (non-zero whole number), reason (3+ characters) and try again.", ok: false },
  insufficient: { text: "A revoke cannot take the balance below zero.", ok: false },
  forbidden: { text: "Only a superadmin can change credits.", ok: false },
  error: { text: "Something went wrong. Nothing was changed; try again.", ok: false },
};

const searchSchema = z.object({
  q: z.string().trim().max(100).catch(""),
  page: z.coerce.number().int().min(1).max(10_000).catch(1),
  flash: z.string().optional(),
});

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { role } = await requireAdmin();
  const raw = await searchParams;
  const { q, page, flash } = searchSchema.parse({
    q: typeof raw.q === "string" ? raw.q : "",
    page: typeof raw.page === "string" ? raw.page : 1,
    flash: typeof raw.flash === "string" ? raw.flash : undefined,
  });

  const { data, error } = await createAdminClient().rpc("admin_user_overview", {
    p_search: q || null,
    p_limit: PAGE_SIZE,
    p_offset: (page - 1) * PAGE_SIZE,
  });

  const parsed = z.array(userOverviewRowSchema).safeParse(data ?? []);
  const rows = parsed.success ? parsed.data : [];
  const loadFailed = Boolean(error) || !parsed.success;
  const total = rows[0]?.total_count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const mayAdjust = canAdjustCredits(role);
  const notice = flash ? FLASH[flash] : undefined;

  const pageHref = (p: number) => `/admin/users?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) }).toString()}`;

  return (
    <AdminShell current="users" role={role}>
      <div className="pm-pagehead">
        <div>
          <h1>Users</h1>
          <p>Every account with its workspace and credit balance.</p>
        </div>
      </div>

      {notice ? (
        <p role="status" className={notice.ok ? "pm-note pm-note-ok" : "pm-note pm-note-bad"}>
          {notice.text}
        </p>
      ) : null}
      {loadFailed ? (
        <p className="pm-note pm-note-bad">Could not load users. Check SUPABASE_SERVICE_ROLE_KEY and migration 0004.</p>
      ) : null}

      <form action="/admin/users" method="get" className="pm-toolbar">
        <input name="q" defaultValue={q} placeholder="Search by email" aria-label="Search by email" className="pm-input" />
        <button type="submit" className="pm-btn pm-btn-quiet">
          Search
        </button>
      </form>

      <div className="pm-tablewrap">
        <table className="pm-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Workspace</th>
              <th className="pm-num">Credits</th>
              <th>Joined</th>
              <th>Last sign-in</th>
              {mayAdjust ? <th>Adjust credits</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.user_id}>
                <td>
                  {r.email ?? "—"}
                  {r.suspended ? " (suspended)" : ""}
                </td>
                <td>{r.role}</td>
                <td>{r.workspace_name ?? "—"}</td>
                <td className="pm-num">
                  {r.credits_available}
                  {r.credits_held > 0 ? <span className="pm-muted"> (+{r.credits_held} held)</span> : null}
                </td>
                <td className="pm-nowrap">{r.created_at.slice(0, 10)}</td>
                <td className="pm-nowrap">{r.last_sign_in_at ? r.last_sign_in_at.slice(0, 10) : "—"}</td>
                {mayAdjust ? (
                  <td>
                    {r.workspace_id ? (
                      <form action={adjustCredits} className="pm-inline">
                        <input type="hidden" name="workspaceId" value={r.workspace_id} />
                        <input type="hidden" name="key" value={newIdempotencyKey()} />
                        <input
                          name="delta"
                          type="number"
                          step={1}
                          required
                          placeholder="±credits"
                          aria-label="Credits to add or remove"
                          className="pm-input pm-input-sm"
                          style={{ width: "6.5rem" }}
                        />
                        <input
                          name="reason"
                          required
                          minLength={3}
                          maxLength={200}
                          placeholder="Reason (logged)"
                          aria-label="Reason"
                          className="pm-input pm-input-sm"
                          style={{ width: "10rem" }}
                        />
                        <button type="submit" className="pm-btn pm-btn-brand pm-btn-xs">
                          Apply
                        </button>
                      </form>
                    ) : (
                      "—"
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
            {rows.length === 0 && !loadFailed ? (
              <tr>
                <td colSpan={mayAdjust ? 7 : 6} className="pm-empty-row">
                  No users found.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <nav className="pm-pager" aria-label="Pages">
        <span>
          {total} user{total === 1 ? "" : "s"}, page {page} of {pages}
        </span>
        <div>
          {page > 1 ? (
            <Link href={pageHref(page - 1)} className="pm-btn pm-btn-quiet pm-btn-sm">
              Previous
            </Link>
          ) : null}
          {page < pages ? (
            <Link href={pageHref(page + 1)} className="pm-btn pm-btn-quiet pm-btn-sm">
              Next
            </Link>
          ) : null}
        </div>
      </nav>
    </AdminShell>
  );
}
