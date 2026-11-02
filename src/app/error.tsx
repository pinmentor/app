"use client";

import Link from "next/link";

/** Last-resort error page for a route. Shows no internal details (hard rule: secrets/errors never reach the user). */
export default function RouteError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="pm-wrap pm-page">
      <div className="pm-empty" role="alert">
        <h2>Something went wrong</h2>
        <p>The page could not be shown. Nothing was changed. Try again; if it keeps happening, go back to your home page.</p>
        <button type="button" className="pm-btn pm-btn-primary" onClick={() => reset()}>Try again</button>
        <p><Link href="/dashboard">Go to Home</Link></p>
      </div>
    </main>
  );
}
