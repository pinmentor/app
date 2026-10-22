import { z } from "zod";
import { AdminShell } from "@/app/admin/admin-nav";
import { requireAdmin } from "@/lib/admin/guard";
import { canManageRates } from "@/lib/admin/roles";
import { articleCostRowSchema, KNOWN_RATES, rateRowSchema, taskCostRowSchema, tokens, usd } from "@/lib/admin/credit-rates";
import { createAdminClient } from "@/lib/supabase/admin";
import { removeRate, setRate } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Credit prices — PinMentor Admin" };

const FLASH: Record<string, { text: (a: string) => string; ok: boolean }> = {
  saved: { text: (a) => `Price for ${a} saved.`, ok: true },
  removed: { text: (a) => `Price for ${a} removed. Anything that needs it will refuse to run until a new price is set.`, ok: true },
  nothing_to_remove: { text: (a) => `There was no price for ${a}.`, ok: false },
  protected: { text: (a) => `The price for ${a} cannot be removed.`, ok: false },
  invalid: { text: () => "That price is not valid: a whole number from 0 to 100000, and a note of at most 200 characters.", ok: false },
  forbidden: { text: () => "Only a superadmin can change credit prices.", ok: false },
  error: { text: () => "Something went wrong. Nothing was changed; try again.", ok: false },
};

const DAYS = 14;
const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

export default async function CreditsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { role } = await requireAdmin();
  const raw = await searchParams;
  const may = canManageRates(role);
  const sb = createAdminClient();

  const [ratesRes, taskRes, artRes] = await Promise.all([
    sb.from("credit_rates").select("action, credits, note, updated_at").order("action"),
    sb.rpc("admin_llm_cost_by_task", { p_days: DAYS }),
    sb.rpc("admin_article_cost_summary", { p_days: DAYS }),
  ]);
  const rates = z.array(rateRowSchema).safeParse(ratesRes.data ?? []);
  const tasks = z.array(taskCostRowSchema).safeParse(taskRes.data ?? []);
  const arts = z.array(articleCostRowSchema).safeParse(artRes.data ?? []);
  const failed = Boolean(ratesRes.error || taskRes.error || artRes.error) || !rates.success || !tasks.success || !arts.success;
  const rows = new Map((rates.success ? rates.data : []).map((r) => [r.action, r]));
  const actions = Array.from(new Set([...Object.keys(KNOWN_RATES), ...rows.keys()]));

  const flashKey = typeof raw.flash === "string" ? raw.flash : undefined;
  const flashAction = typeof raw.a === "string" && /^[a-z][a-z0-9_.]{1,63}$/.test(raw.a) ? raw.a : "this action";
  const flash = flashKey ? FLASH[flashKey] : undefined;
  const ready = (arts.success ? arts.data : []).find((r) => r.status === "ready");

  return (
    <AdminShell current="credits" role={role}>
      <div className="pm-pagehead">
        <div>
          <h1>Credit prices</h1>
          <p>What a customer pays, in credits. Only a superadmin can change it. There is no built-in price: until you set one, writing is blocked.</p>
        </div>
      </div>

      {flash ? (
        <p role="status" className={flash.ok ? "pm-note pm-note-ok" : "pm-note pm-note-bad"}>
          {flash.text(flashAction)}
        </p>
      ) : null}
      {failed ? <p className="pm-note pm-note-bad">Could not load everything. Check that migrations 0017 and 0018 are applied.</p> : null}

      <section className="pm-price" aria-labelledby="price-h">
        <div>
          <h2 id="price-h">Price to write one article</h2>
          <p className="pm-muted" style={{ margin: "0.2rem 0 0" }}>Credits taken per article that comes out ready. A failed article is free. 0 = free (for testing).</p>
        </div>
        {rows.get("article_write") ? <span className="pm-bignum">{rows.get("article_write")?.credits}</span> : <span className="pm-bignum pm-bignum-plain">not set</span>}
        {may ? (
          <form action={setRate} className="pm-inline" style={{ gap: "0.5rem" }}>
            <input type="hidden" name="action" value="article_write" />
            <input name="credits" type="number" min={0} max={100000} step={1} required defaultValue={rows.get("article_write")?.credits} aria-label="Credits per article" placeholder="credits" className="pm-input" style={{ width: "7rem" }} />
            <button type="submit" className="pm-btn pm-btn-primary">Save price</button>
          </form>
        ) : null}
      </section>

      <section className="pm-section">
        <h2>What one article really costs us</h2>
        {ready ? (
          <p>
            Average over {ready.articles} ready article{ready.articles === 1 ? "" : "s"} (last {DAYS} days): <span className="pm-bignum pm-bignum-plain">{usd(ready.avg_cost_usd)}</span>{" "}
            <span className="pm-muted">
              per article · {tokens(ready.avg_input_tok)} input and {tokens(ready.avg_output_tok)} output tokens · cheapest {usd(ready.min_cost_usd)}, dearest {usd(ready.max_cost_usd)}
            </span>
          </p>
        ) : (
          <p>No article has been written yet. Write one small batch (with the price set to 0) and the real cost appears here.</p>
        )}
      </section>

      <details className="pm-more">
        <summary>Details: all prices and AI cost by task</summary>

      <h2>Prices</h2>
      <div className="pm-tablewrap">
        <table className="pm-table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Price (credits)</th>
              <th>Note</th>
              <th>Updated</th>
              {may ? <th>Change</th> : null}
            </tr>
          </thead>
          <tbody>
            {actions.map((a) => {
              const r = rows.get(a);
              const def = KNOWN_RATES[a];
              return (
                <tr key={a}>
                  <td>
                    <strong>{def?.label ?? a}</strong>
                    <br />
                    <code>{a}</code>
                    {def ? <><br /><small>{def.unit}</small></> : null}
                  </td>
                  <td>{r ? <strong>{r.credits}</strong> : <span className="pm-tone-dead">not set</span>}</td>
                  <td>{r?.note ?? ""}</td>
                  <td>{r ? `${when(r.updated_at)} UTC` : ""}</td>
                  {may ? (
                    <td>
                      <form action={setRate} className="pm-inline">
                        <input type="hidden" name="action" value={a} />
                        <input name="credits" type="number" min={0} max={100000} step={1} required defaultValue={r?.credits} aria-label={`Price for ${a}`} className="pm-input" />
                        <input name="note" maxLength={200} defaultValue={r?.note ?? ""} placeholder="Note (optional)" aria-label={`Note for ${a}`} className="pm-input" />
                        <button type="submit" className="pm-btn pm-btn-brand pm-btn-sm">{r ? "Update" : "Set price"}</button>
                      </form>
                      {r && a !== "test_job" ? (
                        <form action={removeRate}>
                          <input type="hidden" name="action" value={a} />
                          <button type="submit" className="pm-btn pm-btn-ghost pm-btn-sm">Remove</button>
                        </form>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="pm-keymeta">
        A batch run holds <code>price × articles</code> up front and charges only the articles that come out ready. While{" "}
        <code>article_write</code> has no price, running a batch is refused. A price of 0 makes a run free (useful for testing).
      </p>

      <h2>Articles by status</h2>
      <div className="pm-tablewrap">
        <table className="pm-table">
          <thead>
            <tr><th>Articles</th><th>Count</th><th>Avg AI calls</th><th>Avg input tok</th><th>Avg output tok</th><th>Avg cost</th><th>Min</th><th>Max</th><th>Total</th></tr>
          </thead>
          <tbody>
            {(arts.success ? arts.data : []).map((r) => (
              <tr key={r.status}>
                <td>{r.status}</td><td>{r.articles}</td><td>{r.avg_calls === null ? "—" : r.avg_calls.toFixed(1)}</td><td>{tokens(r.avg_input_tok)}</td>
                <td>{tokens(r.avg_output_tok)}</td><td>{usd(r.avg_cost_usd)}</td><td>{usd(r.min_cost_usd)}</td><td>{usd(r.max_cost_usd)}</td><td>{usd(r.total_cost_usd)}</td>
              </tr>
            ))}
            {arts.success && arts.data.length === 0 ? <tr><td colSpan={9}>Nothing yet.</td></tr> : null}
          </tbody>
        </table>
      </div>

      <h2>AI calls by task</h2>
      <div className="pm-tablewrap">
        <table className="pm-table">
          <thead>
            <tr><th>Task</th><th>OK calls</th><th>Failed</th><th>Avg input tok</th><th>Avg output tok</th><th>Avg cost / call</th><th>Total</th></tr>
          </thead>
          <tbody>
            {(tasks.success ? tasks.data : []).map((r) => (
              <tr key={r.task}>
                <td><code>{r.task}</code></td><td>{r.ok_calls}</td><td>{r.failed_calls}</td><td>{tokens(r.avg_input_tok)}</td>
                <td>{tokens(r.avg_output_tok)}</td><td>{usd(r.avg_cost_usd)}</td><td>{usd(r.total_cost_usd)}</td>
              </tr>
            ))}
            {tasks.success && tasks.data.length === 0 ? <tr><td colSpan={7}>No AI calls in this period.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <p className="pm-keymeta">Costs are what the AI providers charge us in USD, as recorded per call. The total includes failed calls when the provider billed for them.</p>
      </details>
    </AdminShell>
  );
}
