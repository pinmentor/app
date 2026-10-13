import { createBrowserClient } from "@supabase/ssr";
import { requirePublicEnv } from "@/lib/env";

/** Browser Supabase client (anon key + the user's session cookie). Used only for the 2FA enrol/verify UI. */
export function createClient() {
  const env = requirePublicEnv();
  return createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
