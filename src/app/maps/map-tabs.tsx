import Link from "next/link";

export type MapTab = "review" | "dashboard" | "batches";

/** The three views of one map: review (approve, edit), dashboard (progress), batches (what is written together). */
export function MapTabs({ id, current }: { id: string; current: MapTab }) {
  const tabs: { key: MapTab; label: string; href: string }[] = [
    { key: "review", label: "Review", href: `/maps/${id}` },
    { key: "dashboard", label: "Dashboard", href: `/maps/${id}/dashboard` },
    { key: "batches", label: "Batches", href: `/maps/${id}/batches` },
  ];
  return (
    <nav className="pm-tabs" aria-label="Map views">
      {tabs.map((t) =>
        t.key === current ? (
          <span key={t.key} className="pm-tab pm-tab-on" aria-current="page">{t.label}</span>
        ) : (
          <Link key={t.key} href={t.href} className="pm-tab">{t.label}</Link>
        ),
      )}
    </nav>
  );
}
