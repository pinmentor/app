import { NextResponse, type NextRequest } from "next/server";
import { isCronAuthorized } from "@/modules/jobs/auth";
import { runTick } from "@/modules/jobs/runner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Worker tick. Protected by CRON_SECRET (`Authorization: Bearer ...`), called every minute by pg_cron/pg_net
 * (supabase/ops/schedule_jobs.sql). GET is accepted too so Vercel Cron can call it. Fails closed.
 */
async function handle(request: NextRequest) {
  if (!isCronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await runTick()) });
  } catch {
    return NextResponse.json({ ok: false, error: "tick_failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
