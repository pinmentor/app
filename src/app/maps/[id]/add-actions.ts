"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { embedTexts } from "@/modules/llm/embed";
import { findMatches, parseAddForm, parseVector, type Existing } from "@/modules/topical-map/manual-add";
import { thresholdsFor } from "@/modules/topical-map/stage-config";
import type { Locale } from "@/modules/topical-map/lexicon";

const runSchema = z.object({ id: z.string().uuid(), workspace_id: z.string().uuid(), locale: z.string(), params: z.record(z.string(), z.unknown()) });
const itemSchema = z.object({ id: z.string().uuid(), silo_id: z.string().uuid().nullable(), keyword: z.string(), variants: z.array(z.string()), primary_kw_id: z.string().uuid() });
const siloSchema = z.object({ id: z.string().uuid(), name: z.string() });
const vecRow = z.object({ id: z.string().uuid(), embedding: z.unknown() });

/**
 * "Add a keyword" on the review page, three intents from one form:
 *  check   - look for the same intent first; no match -> add it, a match -> back to the page with a confirm panel
 *  force   - add as its own article although a match was shown (the owner decided)
 *  variant - add the text as a variant of the item the owner picked
 * The user is authenticated here; the SQL functions re-check membership, finished run, approved items and silo.
 * No model judge and no credits: rules + one embedding (a failed embedding only means the rules decide alone).
 */
export async function addKeyword(formData: FormData) {
  const form = parseAddForm(formData);
  const runRaw = String(formData.get("run") ?? "");
  const gloss = String(formData.get("gloss") ?? "off");
  const base = /^[0-9a-f-]{36}$/i.test(runRaw) ? `/maps/${runRaw}?gloss=${encodeURIComponent(gloss)}` : "/maps";
  if (!form) redirect(`${base}&flash=add-invalid`);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/maps/${form.run}`)}`);
  const back = (flash: string, extra = "") => `${base}&flash=${flash}${extra}`;
  const sb = createAdminClient();

  if (form.intent === "variant") {
    const res = await sb.rpc("plan_item_add_variant", { p_user: user.id, p_run: form.run, p_item: form.variantOf, p_text: form.text });
    revalidatePath(`/maps/${form.run}`);
    redirect(back(flashFor(res.error?.code, res.error?.message, "add-variant")));
  }

  if (form.intent === "check") {
    // RLS: a map of another workspace is simply not found
    const runRes = await supabase.from("map_runs").select("id, workspace_id, locale, params").eq("id", form.run).maybeSingle();
    const run = runSchema.safeParse(runRes.data);
    if (!run.success) redirect(back("gone"));
    const [itemsRes, silosRes] = await Promise.all([
      supabase.from("plan_items").select("id, silo_id, keyword, variants, primary_kw_id").eq("map_run_id", form.run).limit(1000),
      supabase.from("silos").select("id, name").eq("map_run_id", form.run),
    ]);
    const items = z.array(itemSchema).safeParse(itemsRes.data ?? []);
    const silos = z.array(siloSchema).safeParse(silosRes.data ?? []);
    if (!items.success || !silos.success) redirect(back("error"));

    // the embedding column is service-only (0009): read it with the admin client, only for this run's primaries
    const vecs = new Map<string, number[]>();
    const vr = await sb.from("kw_candidates").select("id, embedding").in("id", items.data.map((i) => i.primary_kw_id));
    for (const r of z.array(vecRow).safeParse(vr.data ?? []).data ?? []) {
      const v = parseVector(r.embedding);
      if (v) vecs.set(r.id, v);
    }
    let newVec: number[] | null = null;
    try {
      const e = await embedTexts({ workspaceId: run.data.workspace_id, texts: [form.text] });
      newVec = e.vectors[0] ?? null;
    } catch {
      newVec = null; // rules decide alone
    }
    const siloName = new Map(silos.data.map((s) => [s.id, s.name]));
    const existing: Existing[] = items.data.flatMap((i) => {
      const sn = siloName.get(i.silo_id ?? "") ?? "";
      const own: Existing = { itemId: i.id, keyword: i.keyword, text: i.keyword, isVariant: false, siloName: sn, vector: vecs.get(i.primary_kw_id) ?? null };
      return [own, ...i.variants.map((v): Existing => ({ itemId: i.id, keyword: i.keyword, text: v, isVariant: true, siloName: sn, vector: null }))];
    });
    const locale: Locale = (["es-MX", "es-US", "es-ES", "en-US"] as const).find((l) => l === run.data.locale) ?? "es-MX";
    const matches = findMatches(form.text, locale, thresholdsFor(run.data.params), newVec, existing);
    if (matches.length > 0) {
      const m = matches.map((x) => `${x.itemId}.${x.kind === "same" ? "s" : "x"}`).join(",");
      const q = `&add=${encodeURIComponent(form.text)}&silo=${form.silo}&m=${m}${form.title ? `&title=${encodeURIComponent(form.title)}` : ""}`;
      redirect(back("add-confirm", q));
    }
  }

  const res = await sb.rpc("plan_item_add_manual", { p_user: user.id, p_run: form.run, p_text: form.text, p_title: form.title ?? null, p_silo: form.silo, p_force: form.force });
  revalidatePath(`/maps/${form.run}`);
  redirect(back(flashFor(res.error?.code, res.error?.message, "add-done")));
}

function flashFor(code: string | undefined, message: string | undefined, ok: string): string {
  if (!code) return ok;
  console.error("manual add failed", code);
  if (code === "PM006") return "add-exists";
  if (code === "PM003") return message?.includes("item_in_progress") ? "inbatch" : "locked";
  if (code === "42501") return "forbidden";
  if (code === "PM004") return "gone";
  if (code === "22023") return "add-invalid";
  return "error";
}
