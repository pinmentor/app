import Link from "next/link";
import { Logo } from "@/components/brand";
import { signOut } from "@/app/dashboard/actions";

type Section = "users" | "jobs" | "keys";

const UsersIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c2 .7 3.2 2.3 3.5 5.2" />
  </svg>
);
const JobsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M4 6h16M4 12h16M4 18h9" />
    <circle cx="18" cy="18" r="2.5" />
  </svg>
);

const KeyIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12l9-9M16 7l3 3M14 9l2 2" />
  </svg>
);

/** Admin chrome: dark sidebar on desktop, top bar on small screens. Wraps every admin page. */
export function AdminShell({
  current,
  role,
  children,
}: {
  current: Section;
  role: string;
  children: React.ReactNode;
}) {
  const link = (href: string, label: string, key: Section, icon: React.ReactNode) => (
    <Link href={href} className="pm-sidelink" aria-current={current === key ? "page" : undefined}>
      {icon}
      {label}
    </Link>
  );
  return (
    <div className="pm-admin">
      <aside className="pm-side">
        <Logo href="/admin/users" />
        <nav className="pm-sidenav" aria-label="Admin">
          {link("/admin/users", "Users", "users", <UsersIcon />)}
          {link("/admin/jobs", "Jobs & LLM", "jobs", <JobsIcon />)}
          {link("/admin/integrations", "API keys", "keys", <KeyIcon />)}
        </nav>
        <div className="pm-sidefoot">
          <span>Signed in as {role}</span>
          <form action={signOut}>
            <button type="submit" className="pm-btn pm-btn-ghost pm-btn-sm pm-btn-block">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="pm-admin-main">{children}</main>
    </div>
  );
}
