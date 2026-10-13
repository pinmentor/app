import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { requirePublicEnv } from "@/lib/env";

/** Supabase client for Server Components, Server Actions and Route Handlers (anon key + user session; RLS applies). */
export async function createClient() {
  // Read cookies first: this marks the caller as request-time (dynamic), so Next never tries to
  // prerender a page at build time and trip over env that only exists at runtime.
  const cookieStore = await cookies();
  const env = requirePublicEnv();

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // Safe to ignore: the proxy refreshes the session on every request.
        }
      },
    },
  });
}
