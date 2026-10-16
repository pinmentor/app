import Link from "next/link";

/** The pin mark: a map pin whose head is a contour ring. Same drawing as src/app/icon.svg. */
export function PinMark() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="#0A5C63" />
      <path
        d="M32 11c-8.3 0-15 6.4-15 14.4 0 9.9 11 21.9 14 25.1a1.5 1.5 0 0 0 2 0c3-3.2 14-15.2 14-25.1C47 17.4 40.3 11 32 11Z"
        fill="#E9446C"
      />
      <circle cx="32" cy="25.5" r="5.6" fill="#fff" />
    </svg>
  );
}

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="pm-logo">
      <PinMark />
      PinMentor
    </Link>
  );
}

/** Credit coin: marigold disc with an engraved ring. */
export function Coin() {
  return (
    <svg className="pm-coin" viewBox="0 0 56 56" aria-hidden="true">
      <circle cx="28" cy="28" r="26" fill="var(--gold)" />
      <circle cx="28" cy="28" r="19" fill="none" stroke="var(--gold-ink)" strokeWidth="2" opacity="0.55" />
      <path d="M28 17v22M22 23h9a4 4 0 0 1 0 8h-9" fill="none" stroke="var(--gold-ink)" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
