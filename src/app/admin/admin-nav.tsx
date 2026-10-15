import Link from "next/link";

export function AdminNav({ current }: { current: "users" | "jobs" }) {
  const link = (href: string, label: string, active: boolean) => (
    <Link href={href} className={active ? "font-semibold underline" : "text-neutral-600 hover:underline"}>
      {label}
    </Link>
  );
  return (
    <nav className="flex gap-4 text-sm">
      {link("/admin/users", "Users", current === "users")}
      {link("/admin/jobs", "Jobs & LLM", current === "jobs")}
    </nav>
  );
}
