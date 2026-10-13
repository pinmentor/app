import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-4xl font-semibold tracking-tight">PinMentor</h1>
      <p className="text-neutral-600">Under construction — Phase 0 foundation is live.</p>
      <Link href="/login" className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white">
        Sign in
      </Link>
    </main>
  );
}
