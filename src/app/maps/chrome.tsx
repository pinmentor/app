import type { ReactNode } from "react";
import { Logo } from "@/components/brand";
import { NavLinks } from "@/components/nav-links";
import { Stepper } from "@/components/stepper";
import { signOut } from "@/app/dashboard/actions";
import { stepper } from "@/lib/home/stepper";
import { loadStepperInput } from "@/lib/home/stepper-data";
import { createClient } from "@/lib/supabase/server";

/** Header, main navigation, the 8-step ladder and page frame of the signed-in user pages. */
export async function AppFrame({ email, children }: { email: string; children: ReactNode }) {
  let ladder: ReturnType<typeof stepper> | null = null;
  try {
    const input = await loadStepperInput(await createClient());
    if (input) ladder = stepper(input);
  } catch {
    ladder = null; // the ladder is a guide; a failure here must never break the page
  }
  return (
    <>
      <header className="pm-appbar">
        <div className="pm-wrap pm-appbar-in">
          <Logo href="/dashboard" />
          <div className="pm-appbar-user">
            <span>{email}</span>
            <form action={signOut}>
              <button type="submit" className="pm-btn pm-btn-quiet pm-btn-sm">
                Sign out
              </button>
            </form>
          </div>
        </div>
        <div className="pm-wrap">
          <NavLinks />
        </div>
      </header>
      <main className="pm-wrap pm-page">
        {ladder ? <Stepper steps={ladder.steps} /> : null}
        {children}
      </main>
    </>
  );
}
