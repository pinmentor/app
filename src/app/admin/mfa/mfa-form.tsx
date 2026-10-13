"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Enrollment = { id: string; qr: string; secret: string };

export function MfaForm({ factorId }: { factorId?: string }) {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const activeFactorId = factorId ?? enrollment?.id;

  async function startEnroll() {
    setBusy(true);
    setError(null);
    const { data, error: enrollError } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `PinMentor ${new Date().toISOString()}`,
    });
    setBusy(false);
    if (enrollError || !data) {
      setError("Could not start 2FA setup. Check that TOTP is enabled in Supabase → Authentication → Multi-Factor.");
      return;
    }
    setEnrollment({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  }

  async function verify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeFactorId) return;
    setBusy(true);
    setError(null);
    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
      factorId: activeFactorId,
      code: code.trim(),
    });
    setBusy(false);
    if (verifyError) {
      setError("That code was not accepted. Wait for the next code and try again.");
      return;
    }
    router.replace("/admin/users");
    router.refresh();
  }

  if (!activeFactorId) {
    return (
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={startEnroll}
          disabled={busy}
          className="rounded-md bg-neutral-900 px-4 py-2 font-medium text-white disabled:opacity-60"
        >
          {busy ? "Starting…" : "Set up authenticator app"}
        </button>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </div>
    );
  }

  return (
    <form onSubmit={verify} className="flex flex-col gap-4">
      {enrollment ? (
        <div className="flex flex-col items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={enrollment.qr} alt="Authenticator QR code" className="h-44 w-44" />
          <p className="text-center text-xs text-neutral-600">
            Can&apos;t scan? Enter this key manually: <code className="break-all">{enrollment.secret}</code>
          </p>
        </div>
      ) : null}

      <label className="flex flex-col gap-1 text-sm font-medium">
        6-digit code
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="rounded-md border border-neutral-300 px-3 py-2 text-base font-normal tracking-widest outline-none focus:border-neutral-900"
        />
      </label>

      <button
        type="submit"
        disabled={busy || code.trim().length !== 6}
        className="rounded-md bg-neutral-900 px-4 py-2 font-medium text-white disabled:opacity-60"
      >
        {busy ? "Checking…" : "Verify"}
      </button>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </form>
  );
}
