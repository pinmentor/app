# PROGRESS

> প্রতিটি ব্যাচ শেষে এজেন্ট এটা আপডেট করে। নতুন সেশনে `CLAUDE.md`-এর পরেই এটা পড়তে হবে।

## সম্পন্ন ব্যাচ
- **01A (টাস্ক 0.1, 0.7, 0.8 আংশিক):** Next.js 16 (App Router, TS strict) + Tailwind 4 + ESLint + Vitest; `src/lib/slugify.ts` (৩৩ টেস্ট, সাল-স্ট্রিপ), `src/lib/languages.ts`; GitHub Actions CI (lint/typecheck/test/build)। লোকালি চারটা কমান্ড সবুজ। সিদ্ধান্ত: TypeScript 5-এ পিন (TS 7 টাইপস্ক্রিপ্ট-eslint-এর সাথে চলে না); shadcn/ui ও Playwright স্মোক UI-ওয়ালা ব্যাচে (01B) যোগ হবে; `languages` DB সিড 01B-র মাইগ্রেশনে।
- **01B (টাস্ক 0.2, 0.3) — মালিক-যাচাইকৃত:** মাইগ্রেশন `0001_core_schema.sql` (`languages` es/en সিড, `profiles`, `workspaces`, `workspace_members`, `trials`, সাইন-আপ ট্রিগার, সব টেবিলে RLS); `rls_0001.sql` আসল Supabase-এ ৩৫/৩৫ পাস। অ্যাপ: ম্যাজিক-লিংক লগইন + Turnstile (Supabase-এর নিজস্ব Captcha দিয়ে যাচাই), `/auth/callback`, `proxy.ts` সেশন-রিফ্রেশ, `/dashboard`। Vercel বিল্ড সবুজ; নতুন ইউজার → workspace + ৩০ ট্রায়াল ক্রেডিট দেখা গেছে।

## চলমান ব্যাচ
**Batch 01C — টাস্ক 0.4, 0.5, 0.6।** SQL অংশ লোকাল Postgres 16-এ যাচাইকৃত; অ্যাপ-কোড (`track()`, `/admin`) **অযাচাইকৃত** (এজেন্টের ওয়ার্কস্পেসে npm ব্লক) — প্রথম যাচাই GitHub Actions/Vercel।

- **0.4 ক্রেডিট লেজার — `0002_credit_ledger.sql`:** `credit_ledger` (append-only: শুধু `held → committed|released` বদলায়, ডিলিট নিষিদ্ধ, ওয়ার্কস্পেস/ইউজার ডিলিটে cascade চলে), `credit_reserve / credit_commit / credit_release / credit_adjust / credit_balance`। প্রতিটা idempotency-key দিয়ে ইডেম্পোটেন্ট; ওয়ার্কস্পেস-প্রতি advisory lock। শুধু `service_role` ফাংশন চালাতে পারে; মেম্বাররা নিজের লেজার শুধু `select` করতে পারে। ট্রায়াল গ্রান্ট এখন লেজারে ঢোকে (পুরনো ট্রায়াল ব্যাকফিল হয়েছে)। এরর-কোড: `PM001` insufficient_credits, `PM002` idempotency_conflict, `PM003` invalid_state, `PM004` not_found।
  - অ্যাকসেপ্টেন্স: ৫০ প্যারালাল reserve কখনো ওভারড্রাফট করে না (১০০ ক্রেডিটে ১০ সফল/৪০ প্রত্যাখ্যান, ব্যালান্স কখনো ঋণাত্মক নয়); একই কী ×৫০ = ১টা সারি; ডাবল-কমিট ×৫০ = একবারই কাটে। `supabase/tests/credit_concurrency.sh` (SQL Editor-এ নয়, `psql` সহ কম্পিউটার/সার্ভার থেকে `DATABASE_URL` দিয়ে চালাতে হয়)। লক সরিয়ে দেখা গেছে টেস্ট ফেল করে (ব্যালান্স −১৮০), অর্থাৎ টেস্ট কাজের।
- **0.5 events + audit — `0003_events_audit.sql` + `src/lib/events.ts`:** `events` (কাঁচা, ক্লায়েন্টের অ্যাক্সেস নেই), `admin_audit` (append-only; নাম `admin_audit`, PLAN §১১ ও CLAUDE.md অনুযায়ী — টাস্ক-টেবিলের "audit_log" নয়), `purge_old_events(days ≥ 14)`, `signup` ও `email_verified` ইভেন্ট DB ট্রিগার থেকে আসে। `track()` ইনপুট Zod-এ ভ্যালিডেট করে, ইমেইল-জাতীয় props ফেরত দেয়, কখনো থ্রো করে না।
- **0.6 অ্যাডমিন — `0004_admin.sql` + `/admin`:** `admin_user_overview()` ও `admin_credit_adjust()` (ডাটাবেসেই superadmin পুনঃযাচাই; লেজার + `admin_audit` একই ট্রানজ্যাকশনে; রিপ্লে নিরাপদ)। অ্যাপ: `requireAdmin()` গার্ড (লগইন → অ্যাডমিন-রোল নয় হলে 404 → TOTP `aal2` না থাকলে `/admin/mfa`), `/admin/mfa` (QR দিয়ে এনরোল/কোড ভেরিফাই), `/admin/users` (সার্চ, পেজিনেশন, ক্রেডিট ব্যালান্স), superadmin-এর জন্য অডিটেড ক্রেডিট গ্রান্ট/রিভোক ফর্ম। `/admin` `proxy.ts`-এও সুরক্ষিত।
- **টেস্ট:** `supabase/tests/rls_0002_0004.sql` — লোকালি ৭৫/৭৫ পাস (দুইবার চালিয়ে; চালানোর পর কোনো ডাটা পড়ে থাকে না)। Vitest: `events.test.ts`, `admin/admin.test.ts` (অযাচাইকৃত, CI-তে প্রথম চলবে)।

### 01C-র সিদ্ধান্ত (এজেন্টের নেওয়া — আপত্তি থাকলে বলো)
- ক্রেডিট গ্রান্ট/রিভোক **শুধু superadmin** (PLAN: support-এর "সীমিত" অ্যাডজাস্ট — সীমা অস্পষ্ট, তাই এখন নয়)। `support/finance/analyst` শুধু ইউজার-লিস্ট দেখতে পারে।
- Reserve-এর পরিমাণই কমিট হয় (আংশিক/প্রকৃত খরচে কমিট নেই); মেয়াদোত্তীর্ণ hold-এর স্বয়ংক্রিয় release (watchdog) Phase 1-এর জব সিস্টেমে।
- `admin_audit` শুধু **পরিবর্তনমূলক** অ্যাকশন লগ করে (ক্রেডিট গ্রান্ট/রিভোক)। ইউজার-লিস্ট দেখা লগ হয় না; বাকি অ্যাডমিন অ্যাকশন (সাসপেন্ড ইত্যাদি) আসার সময় লগ যুক্ত হবে।
- `purge_old_events()` এখনো কোনো শিডিউলে বসানো নেই (pg_cron চালু করা/Phase 1 জব-রানার লাগবে)।
- ড্যাশবোর্ডে ব্যালান্স এখনো `trials.granted_credits` থেকে দেখায় ("Trial credits: 30"); লেজারের ব্যালান্স দেখানো পরের UI-ব্যাচে।
- 0003 চালানোর আগে যারা সাইন-আপ করেছে তাদের `signup` ইভেন্ট নেই (শুধু পরের ইউজার থেকে)।

### মালিকের করণীয় (01C)
1. Supabase SQL Editor-এ **ক্রমানুযায়ী** পেস্ট করে Run: `0002_credit_ledger.sql` → `0003_events_audit.sql` → `0004_admin.sql`।
2. তারপর `rls_0002_0004.sql` Run → শেষ সারি `ALL CHECKS | 75 of 75 passed | true` হওয়া চাই (কোনো `false` সারি এলে টেবিলটা পাঠাও)।
3. (ঐচ্ছিক, দ্রুত নিশ্চিতি) `credit_concurrency.sh` — `DATABASE_URL='…' bash supabase/tests/credit_concurrency.sh` → `RESULT: ALL SCENARIOS PASSED`।
4. নিজেকে superadmin বানাও (একবার, SQL Editor-এ): `update public.profiles set role = 'superadmin' where user_id = (select id from auth.users where email = 'তোমার-ইমেইল');`
5. Vercel-এ `SUPABASE_SERVICE_ROLE_KEY` সেট আছে কিনা দেখো (এখন কোডে লাগছে); Supabase → Authentication → Multi-Factor-এ TOTP চালু থাকতে হবে (ডিফল্টে চালু)।
6. GitHub Actions/Vercel সবুজ হলে ম্যানুয়াল টেস্ট: `/admin` → `/admin/mfa`-এ অথেন্টিকেটর অ্যাপ এনরোল → `/admin/users` → একটা ইউজারকে +৫ ক্রেডিট দাও → ইউজার-লিস্টে ব্যালান্স বাড়ে; একই ইউজারের ড্যাশবোর্ডে ঢুকে সাধারণ ইউজার `/admin` খুলতে গেলে 404 পায়।

## পরের ব্যাচ
Batch 01C ফাইনালাইজ — অ্যাপ-কোডের CI সবুজ (লাল হলে এরর পেস্ট করো) + উপরের ম্যানুয়াল টেস্ট
তারপর Batch 02 — Phase 1 (LLM রাউটার, জব কিউ, ক্রেডিট-hold watchdog, `purge_old_events` শিডিউল)

## খোলা সিদ্ধান্ত / ব্লকার
- **লকফাইল ঋণ:** `pnpm-lock.yaml` এখনো পুরনো; সাময়িক ওয়ার্কঅ্যারাউন্ড `.npmrc` (`frozen-lockfile=false`) ও CI-তে `--no-frozen-lockfile`। যেকোনো কম্পিউটারে `pnpm install` চালিয়ে নতুন `pnpm-lock.yaml` কমিট করো, তারপর `.npmrc` মুছে CI-তে `--frozen-lockfile` ফেরাও।
- `@supabase/ssr` 0.6.1-এ পিন (নতুন সংস্করণ আছে); লকফাইল ঠিক হলে আপগ্রেড বিবেচনা।
- shadcn/ui ও Playwright স্মোক এখনো যোগ হয়নি; অ্যাডমিন UI বাড়ার সময় (01C-র পর) যোগ হবে।
- ফেজ 2a-র আগে: SERP প্রোভাইডার ডিপোজিট (PLAN §৩.৭) — Bilal-এর সম্মতি অপেক্ষমান
