import { redirect } from "next/navigation";
import { Logo } from "@/components/brand";
import { requireAdmin } from "@/lib/admin/guard";
import { MfaForm } from "./mfa-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin 2FA — PinMentor" };

export default async function AdminMfaPage() {
  // Role check only: this page is where an admin gets from aal1 to aal2.
  const { supabase } = await requireAdmin({ requireMfa: false });

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel === "aal2") redirect("/admin/users");

  const { data: factors } = await supabase.auth.mfa.listFactors();
  const verifiedTotp = factors?.totp?.[0];

  return (
    <div className="pm-auth">
      <aside className="pm-auth-aside">
        <Logo href="/admin/users" />
        <p className="pm-auth-line">Admin access needs a second key.</p>
      </aside>
      <main className="pm-auth-main">
        <div className="pm-auth-card">
          <div>
            <h1>Two-factor authentication</h1>
            <p className="pm-muted">
              Admin access requires a code from your authenticator app
              {verifiedTotp ? "." : ". Set it up now: scan the QR code, then enter the 6-digit code."}
            </p>
          </div>
          <MfaForm factorId={verifiedTotp?.id} />
        </div>
      </main>
    </div>
  );
}
