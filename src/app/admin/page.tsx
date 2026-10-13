import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin/guard";

export const dynamic = "force-dynamic";

export default async function AdminHome() {
  await requireAdmin();
  redirect("/admin/users");
}
