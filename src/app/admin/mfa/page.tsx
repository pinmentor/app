import { redirect } from "next/navigation";
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
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Two-factor authentication</h1>
        <p className="mt-2 text-sm text-neutral-600">
          Admin access requires a code from your authenticator app
          {verifiedTotp ? "." : ". Set it up now: scan the QR code, then enter the 6-digit code."}
        </p>
      </div>
      <MfaForm factorId={verifiedTotp?.id} />
    </main>
  );
}
