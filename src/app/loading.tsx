/** Shown while a page loads (all routes). Plain text on purpose: it must work before any data is there. */
export default function Loading() {
  return (
    <main className="pm-wrap pm-page" aria-busy="true">
      <p className="pm-muted" role="status">Loading…</p>
    </main>
  );
}
