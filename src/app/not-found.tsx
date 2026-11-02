import Link from "next/link";

export const metadata = { title: "Page not found — PinMentor" };

export default function NotFound() {
  return (
    <main className="pm-wrap pm-page">
      <div className="pm-empty">
        <h2>This page does not exist</h2>
        <p>The address may be wrong, or the item was removed.</p>
        <Link href="/dashboard" className="pm-btn pm-btn-primary">Go to Home</Link>
      </div>
    </main>
  );
}
