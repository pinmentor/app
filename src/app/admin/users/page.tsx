import Link from "next/link";
import { z } from "zod";
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
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-10">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <span className="text-xs uppercase tracking-wide text-neutral-500">{role}</span>
      </header>

      {notice ? (
        <p role="status" className={notice.ok ? "text-sm text-green-700" : "text-sm text-red-600"}>
          {notice.text}
        </p>
      ) : null}
      {loadFailed ? <p className="text-sm text-red-600">Could not load users. Check SUPABASE_SERVICE_ROLE_KEY and migration 0004.</p> : null}

      <form action="/admin/users" method="get" className="flex gap-2">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search by email"
          className="w-full max-w-sm rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
        <button type="submit" className="rounded-md border border-neutral-300 px-3 py-2 text-sm">
          Search
        </button>
      </form>

      <div className="overflow-x-auto rounded-lg border border-neutral-200">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Workspace</th>
              <th className="px-3 py-2 text-right">Credits</th>
              <th className="px-3 py-2">Joined</th>
              <th className="px-3 py-2">Last sign-in</th>
              {mayAdjust ? <th className="px-3 py-2">Adjust credits</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.user_id} className="border-t border-neutral-200 align-top">
                <td className="px-3 py-2">{r.email ?? "—"}{r.suspended ? " (suspended)" : ""}</td>
                <td className="px-3 py-2">{r.role}</td>
                <td className="px-3 py-2">{r.workspace_name ?? "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.credits_available}
                  {r.credits_held > 0 ? <span className="text-neutral-500"> (+{r.credits_held} held)</span> : null}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{r.created_at.slice(0, 10)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.last_sign_in_at ? r.last_sign_in_at.slice(0, 10) : "—"}</td>
                {mayAdjust ? (
                  <td className="px-3 py-2">
                    {r.workspace_id ? (
                      <form action={adjustCredits} className="flex flex-wrap items-center gap-1">
                        <input type="hidden" name="workspaceId" value={r.workspace_id} />
                        <input type="hidden" name="key" value={newIdempotencyKey()} />
                        <input
                          name="delta"
                          type="number"
                          step={1}
                          required
                          placeholder="±credits"
                          className="w-24 rounded border border-neutral-300 px-2 py-1"
                        />
                        <input
                          name="reason"
                          required
                          minLength={3}
                          maxLength={200}
                          placeholder="Reason (logged)"
                          className="w-40 rounded border border-neutral-300 px-2 py-1"
                        />
                        <button type="submit" className="rounded bg-neutral-900 px-2 py-1 text-white">
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
                <td colSpan={mayAdjust ? 7 : 6} className="px-3 py-6 text-center text-neutral-500">
                  No users found.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <nav className="flex items-center justify-between text-sm">
        <span className="text-neutral-600">
          {total} user{total === 1 ? "" : "s"} · page {page} of {pages}
        </span>
        <span className="flex gap-3">
          {page > 1 ? <Link href={pageHref(page - 1)}>← Previous</Link> : null}
          {page < pages ? <Link href={pageHref(page + 1)}>Next →</Link> : null}
        </span>
      </nav>
    </main>
  );
}
