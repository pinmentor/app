"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/dashboard", label: "Home" },
  { href: "/sites", label: "Websites" },
  { href: "/maps", label: "Maps" },
  { href: "/articles", label: "Articles" },
  { href: "/queue", label: "Queue" },
  { href: "/settings", label: "Settings" },
] as const;
const SOON = ["Pins", "Schedule", "Results"] as const;

/** Main navigation of the signed-in pages. Not-built sections are shown as "Soon" so the whole product is visible. */
export function NavLinks() {
  const path = usePathname() ?? "";
  return (
    <nav aria-label="Main" className="pm-nav">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} aria-current={path === l.href || path.startsWith(`${l.href}/`) ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
      {SOON.map((s) => (
        <span key={s} className="pm-nav-soon" title="Not available yet">
          {s} <small>Soon</small>
        </span>
      ))}
    </nav>
  );
}
