import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requirePublicEnv } from "@/lib/env";

const serviceKeySchema = z.string().min(20);

/**
 * Supabase client with the service_role key: bypasses RLS. SERVER ONLY.
 * Never import this from a Client Component, and never pass its results to the browser
 * without filtering. Callers must have done their own role / MFA check first.
 */
export function createAdminClient() {
  const env = requirePublicEnv();
  const key = serviceKeySchema.safeParse(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!key.success) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY (server-side only). Set it in Vercel → Environment Variables.");
  }
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, key.data, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
