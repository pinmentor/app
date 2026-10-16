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
      <div>
        <button
          type="button"
          onClick={startEnroll}
          disabled={busy}
          className="pm-btn pm-btn-primary pm-btn-block"
        >
          {busy ? "Starting…" : "Set up authenticator app"}
        </button>
        {error ? <p className="pm-note pm-note-bad">{error}</p> : null}
      </div>
    );
  }

  return (
    <form onSubmit={verify}>
      {enrollment ? (
        <div className="pm-qrbox">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={enrollment.qr} alt="Authenticator QR code" className="pm-qr-img" />
          <p className="pm-secret">
            Can&apos;t scan? Enter this key manually: <code className="break-all">{enrollment.secret}</code>
          </p>
        </div>
      ) : null}

      <label className="pm-field">
        6-digit code
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="pm-input pm-input-code"
        />
      </label>

      <button
        type="submit"
        disabled={busy || code.trim().length !== 6}
        className="pm-btn pm-btn-primary pm-btn-block"
      >
        {busy ? "Checking…" : "Verify"}
      </button>
      {error ? <p className="pm-note pm-note-bad">{error}</p> : null}
    </form>
  );
}
