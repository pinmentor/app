import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";

/** Event names from PLAN §10.3. `signup` and `email_verified` are also written by DB triggers. */
export const EVENT_NAMES = [
  "signup",
  "email_verified",
  "site_connected",
  "map_created",
  "map_verified",
  "batch_started",
  "article_generated",
  "article_approved",
  "article_published",
  "pins_generated",
  "pin_published",
  "credits_purchased",
  "credits_consumed",
  "trial_exhausted",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

const EMAIL_LIKE = /[^\s@"]+@[^\s@"]+\.[^\s@"]+/;

export const trackInputSchema = z.object({
  name: z.enum(EVENT_NAMES),
  workspaceId: z.uuid(),
  userId: z.uuid().nullish(),
  sessionId: z.string().max(100).nullish(),
  // Ids and counts only. PLAN §10.3 / privacy: no emails, no user content in analytics.
  props: z
    .record(z.string(), z.unknown())
    .default({})
    .refine((p) => !EMAIL_LIKE.test(JSON.stringify(p)), "props must not contain email addresses")
    .refine((p) => JSON.stringify(p).length <= 4000, "props too large"),
});

export type TrackInput = z.input<typeof trackInputSchema>;

/**
 * Records a product event (server only). Never throws: analytics must not break the user's action.
 * Returns true if the row was written.
 */
export async function track(input: TrackInput): Promise<boolean> {
  const parsed = trackInputSchema.safeParse(input);
  if (!parsed.success) {
    console.error("track: invalid event", parsed.error.issues.map((i) => i.message).join("; "));
    return false;
  }
  const e = parsed.data;

  try {
    const { error } = await createAdminClient()
      .from("events")
      .insert({
        workspace_id: e.workspaceId,
        user_id: e.userId ?? null,
        name: e.name,
        props: e.props,
        session_id: e.sessionId ?? null,
      });
    if (error) {
      console.error("track: insert failed", e.name, error.code);
      return false;
    }
    return true;
  } catch {
    console.error("track: unexpected failure", e.name);
    return false;
  }
}
