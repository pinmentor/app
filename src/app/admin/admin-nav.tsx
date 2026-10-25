import Link from "next/link";
import { Logo } from "@/components/brand";
import { signOut } from "@/app/dashboard/actions";

type Section = "overview" | "users" | "jobs" | "keys" | "maps" | "credits";

const HomeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 11l8-7 8 7M6 9.5V20h12V9.5M10 20v-6h4v6" />
  </svg>
);
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

const MapIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="5" r="2.5" />
    <circle cx="5" cy="18" r="2.5" />
    <circle cx="19" cy="18" r="2.5" />
    <path d="M12 7.5v4M12 11.5l-6 4M12 11.5l6 4" />
  </svg>
);

const CoinIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5v9M9.5 10c0-1 1-1.7 2.5-1.7s2.5.7 2.5 1.7-1 1.5-2.5 1.9-2.5.9-2.5 1.9 1 1.7 2.5 1.7 2.5-.7 2.5-1.7" />
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
        <Logo href="/admin" />
        <nav className="pm-sidenav" aria-label="Admin">
          {link("/admin", "Overview", "overview", <HomeIcon />)}
          <p className="pm-sidegroup">Customers</p>
          {link("/admin/users", "Users", "users", <UsersIcon />)}
          {link("/admin/maps", "Topical maps", "maps", <MapIcon />)}
          <p className="pm-sidegroup">Operations</p>
          {link("/admin/jobs", "Jobs & LLM", "jobs", <JobsIcon />)}
          {link("/admin/credits", "Credit prices", "credits", <CoinIcon />)}
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
