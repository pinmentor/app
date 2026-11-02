import type { SupabaseClient } from "@supabase/supabase-js";
import type { StepperInput } from "./stepper";

const APPROVED_OR_LATER = ["approved", "in_batch", "writing", "draft_ready", "in_review", "scheduled", "published", "pins_pending", "done"];

/**
 * Counts for the ladder, read with the signed-in user's own client (RLS: only their workspace(s)).
 * Returns null when anything fails, so the page simply shows no ladder instead of a wrong one.
 */
export async function loadStepperInput(supabase: SupabaseClient): Promise<StepperInput | null> {
  const head = { count: "exact" as const, head: true };
  const [sites, maps, approved, ready, sent] = await Promise.all([
    supabase.from("sites").select("id", head).eq("status", "connected"),
    supabase.from("map_runs").select("id", head).eq("status", "succeeded"),
    supabase.from("plan_items").select("id", head).in("status", APPROVED_OR_LATER),
    supabase.from("articles").select("id", head).eq("status", "ready"),
    supabase.from("articles").select("id", head).eq("status", "ready").not("wp_post_id", "is", null),
  ]);
  if (sites.error || maps.error || approved.error || ready.error || sent.error) return null;
  return {
    sitesConnected: sites.count ?? 0,
    mapsReady: maps.count ?? 0,
    itemsApproved: approved.count ?? 0,
    articlesReady: ready.count ?? 0,
    draftsSent: sent.count ?? 0,
  };
}
