import type { ReactNode } from "react";
import Link from "next/link";
import { Logo } from "@/components/brand";
import { signOut } from "@/app/dashboard/actions";

/** Header and page frame of the signed-in user pages (same look as the dashboard). */
export function AppFrame({ email, children }: { email: string; children: ReactNode }) {
  return (
    <>
      <header className="pm-appbar">
        <div className="pm-wrap pm-appbar-in">
          <Logo href="/dashboard" />
          <div className="pm-appbar-user">
            <Link href="/dashboard">Dashboard</Link>
            <span>{email}</span>
            <form action={signOut}>
              <button type="submit" className="pm-btn pm-btn-quiet pm-btn-sm">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="pm-wrap pm-page">{children}</main>
    </>
  );
}
