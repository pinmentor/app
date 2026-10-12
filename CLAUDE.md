# PinMentor

Multi-user SaaS: topic → verified topical map (100–500+ articles) → batch article generation → WordPress publish/schedule → Pinterest pins.
**Full spec: `docs/PLAN.md` — read it before any task.** Language of the docs is Bengali; code, comments, commit messages and identifiers are English.

## Stack
Next.js (App Router, TypeScript strict), Supabase (Postgres, Auth, RLS, Storage, pgvector, pg_cron, pg_net), Tailwind + shadcn/ui, Vercel. Package manager: pnpm. Tests: Vitest (+ Playwright smoke).

## Hard rules
- Validate every external input and every LLM output with Zod.
- LLM calls only through `src/modules/llm`. Model IDs and prices live in `model_registry` — never hardcode.
- Every data table has `workspace_id` + RLS. A table without RLS policies + a RLS test does not ship.
- Anything that spends credits: reserve → commit/release, with an idempotency key. Never charge without a ledger entry.
- All jobs are idempotent and short (<60s per step). Long work = chunked, resumable stages.
- Secrets never reach the client or logs. BYOK keys and WP/Pinterest tokens are encrypted at rest.
- User-supplied URLs (WordPress sites etc.) go through the SSRF guard before any request.
- Slugs: keyword-only, kebab-case, diacritics → ASCII, **never contain a year (20xx)**. Use `slugify()`; it has tests.
- Articles never show prices/discounts/currency amounts anywhere. CTA text = `sites.cta_label`, identical everywhere on a site.
- Images: dedup before use (provider+external_id and perceptual hash). Unsplash provider stays behind a feature flag (OFF).
- Topical map: same meaning + same intent = one article. Merged keywords become `variants[]` of the primary, never separate items. Dedup changes must keep the golden-set eval (`pnpm eval:dedup`) at or above thresholds.
- Admin routes: role guard + TOTP 2FA; every admin action writes `admin_audit`. View-as is read-only.
- User-facing non-English artifacts (map, titles, articles, pin copy) ship with a language-QA report from a *different* model plus a BN/EN translation gloss; a red result blocks publish (PLAN §5.1).
- Dedup ground truth uses a real `SerpProvider` with location+language set — never the LLM's built-in search (PLAN §3.6).
- Raw `events` / `page_views` are retained 14–30 days only; dashboards read `rollup_daily`.
- Migrations only in `supabase/migrations`. Never edit applied migrations.

## Workflow
- Small commits; PR description says what changed and how it was tested.
- Before adding a dependency, state why in the PR.
- When the spec in PLAN.md is ambiguous, ask — don't guess on money, auth, RLS or data deletion.

## Delivery mode (browser-only GitHub)
The owner uploads files via the GitHub web UI (drag & drop, max 100 files per upload). So: deliver **only new/changed files** with their repo paths, keep each batch < 100 files, and list any files to delete by hand. DB changes = numbered SQL files in `supabase/migrations/` that the owner pastes into the Supabase SQL Editor in order. Never commit `node_modules` or `.env`. Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` before delivering.

## Commands
`pnpm dev` · `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm eval:dedup` · `supabase db reset` · `supabase db lint`
