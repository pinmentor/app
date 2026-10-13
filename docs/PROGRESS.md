# PROGRESS

> প্রতিটি ব্যাচ শেষে এজেন্ট এটা আপডেট করে। নতুন সেশনে `CLAUDE.md`-এর পরেই এটা পড়তে হবে।

## সম্পন্ন ব্যাচ
- **01A (টাস্ক 0.1, 0.7, 0.8 আংশিক):** Next.js 16 (App Router, TS strict) + Tailwind 4 + ESLint + Vitest; `src/lib/slugify.ts` (৩৩ টেস্ট, সাল-স্ট্রিপ), `src/lib/languages.ts`; GitHub Actions CI (lint/typecheck/test/build)। লোকালি চারটা কমান্ড সবুজ। সিদ্ধান্ত: TypeScript 5-এ পিন (TS 7 টাইপস্ক্রিপ্ট-eslint-এর সাথে চলে না); shadcn/ui ও Playwright স্মোক UI-ওয়ালা ব্যাচে (01B) যোগ হবে; `languages` DB সিড 01B-র মাইগ্রেশনে।

## চলমান ব্যাচ
**Batch 01B — আংশিক সম্পন্ন।**
- ✅ **টাস্ক 0.2 (DB):** `supabase/migrations/0001_core_schema.sql` — `languages` (es, en সিড), `profiles`, `workspaces`, `workspace_members`, `trials` (ন্যূনতম) + সাইন-আপ ট্রিগার (profile + workspace + owner membership) + সব টেবিলে RLS। `supabase/tests/rls_0001.sql` লোকাল Postgres 16-এ চালানো: ৩৫/৩৫ পাস (ইচ্ছাকৃত policy ভেঙে দেখা হয়েছে টেস্ট ফেল করে)। আসল Supabase-এ এখনো চালানো হয়নি — মালিককে চালিয়ে মেলাতে হবে।
- ⚠️ **টাস্ক 0.3 (অ্যাপ-কোড) লেখা হয়েছে, কিন্তু অযাচাইকৃত:** এজেন্টের ওয়ার্কস্পেসে npm রেজিস্ট্রি ব্লক ছিল, তাই `pnpm install`/lint/typecheck/test/build চালানো যায়নি। মালিক নিজে অযাচাইকৃত কোড নিতে রাজি হয়েছেন (প্রথম যাচাই = GitHub Actions CI)। **CI/Vercel লাল হলে এরর পেস্ট করে পরের সেশনে ঠিক করতে হবে; ০.৩ "সম্পন্ন" ধরা যাবে চারটা কমান্ড সবুজ হওয়ার পর।**
  - ফাইল: `src/proxy.ts` + `src/lib/supabase/{server,proxy}.ts` (সেশন রিফ্রেশ, `/dashboard` গার্ড), `src/lib/env.ts`, `src/lib/auth/schemas.ts` (+ টেস্ট), `src/app/login/{page,login-form,actions}`, `src/app/auth/callback/route.ts`, `src/app/dashboard/{page,actions}`, হোমে "Sign in" লিংক।
  - নতুন ডিপেন্ডেন্সি (কারণসহ): `@supabase/supabase-js` + `@supabase/ssr` (Auth ও কুকি-সেশন, সার্ভার-সাইড), `zod` (CLAUDE.md: প্রতিটি এক্সটার্নাল ইনপুট Zod-এ ভ্যালিডেট)।
  - **লকফাইল সমস্যা:** `pnpm-lock.yaml` রিজেনারেট করা যায়নি। তাই সাময়িক ওয়ার্কঅ্যারাউন্ড: রুটে `.npmrc` (`frozen-lockfile=false`) এবং CI-তে `--no-frozen-lockfile`। যাতে CI/Vercel লকফাইল ছাড়াই ইনস্টল করে। **পরে:** যেকোনো কম্পিউটারে `pnpm install` চালিয়ে বদলে যাওয়া `pnpm-lock.yaml` কমিট করো, তারপর `.npmrc` মুছে CI-তে `--frozen-lockfile` ফেরাও।
  - জানা সীমা: ম্যাজিক লিংক (PKCE) অবশ্যই **যে ব্রাউজারে অনুরোধ করা হয়েছে সেটাতেই** খুলতে হবে। নতুন ইউজারের ট্রায়াল ক্রেডিট দেখা যাবে লিংক ক্লিকের পর (ইমেইল কনফার্ম হলে)।

### 01B-র সিদ্ধান্ত (মালিক-অনুমোদিত)
- ট্রায়াল = **৩০ ক্রেডিট**, `trials.granted_credits`-এ; পরিমাণ বদলাতে নতুন মাইগ্রেশনে `grant_trial()` ফাংশন নতুন করে লিখতে হবে (অ্যাডমিন-UI থেকে বদল পরে)। `credit_ledger` আসে 0.4-এ — তখন এই গ্রান্ট লেজারে তোলা হবে।
- ট্রায়াল গ্রান্ট হয় **ইমেইল কনফার্ম হওয়ার সময়** (ম্যাজিক লিংক ক্লিক), সাইন-আপের মুহূর্তে নয়; workspace সাইন-আপেই তৈরি হয়।
- শুধু ম্যাজিক লিংক, পাসওয়ার্ড নেই।
- ডিসপোজেবল-ইমেইল ব্লক ও "এক ট্রায়াল/WP ডোমেইন-Pinterest অ্যাকাউন্ট" নিয়ম এই ব্যাচে নয় (অ্যাডমিন Platform Controls-এর সাথে)।
- ক্লায়েন্টের লেখার অধিকার সর্বনিম্ন: শুধু `profiles.locale` ও `workspaces.name` (মালিক) আপডেটযোগ্য; role/suspended/owner_id/trial কোনোটাই নয়। বাকি সব লেখা ট্রিগার বা সার্ভারের `service_role` দিয়ে।
- Turnstile: Supabase-এর নিজস্ব Captcha প্রটেকশন (Auth → Bot and Abuse Protection → Turnstile) ব্যবহার, যাতে অ্যাপ বাইপাস করে সরাসরি Auth API কল করলেও আটকায়। অ্যাপ শুধু টোকেন পাঠায়; `TURNSTILE_SECRET_KEY` অ্যাপ পড়ে না, Supabase ড্যাশবোর্ডে বসে। `TURNSTILE_SITE_KEY` সার্ভার-সাইডে পড়ে লগইন ফর্মে দেওয়া হয় (Vercel-এ এই নামেই বসাও)।
- shadcn/ui ও Playwright স্মোক এখনো যোগ হয়নি (01B-র টাস্কে নেই); প্রথম প্রকৃত UI-ভারী ব্যাচে (0.6 অ্যাডমিন) যোগ হবে।

### মালিকের করণীয় (0.2 প্রয়োগ)
1. Supabase SQL Editor-এ `0001_core_schema.sql` পেস্ট করে Run।
2. তারপর `rls_0001.sql` পেস্ট করে Run → শেষ সারি `ALL CHECKS | 35 of 35 passed | true` হওয়া চাই; কোনো `false` সারি থাকলে আমাকে পাঠাও।
3. Auth সেটিংস (0.3 কোড চালানোর আগে): Authentication → Providers → Email চালু, "Confirm email" চালু; URL Configuration-এ Site URL ও `/auth/callback` রিডাইরেক্ট যোগ; Bot and Abuse Protection-এ Turnstile + সিক্রেট কী।

## পরের ব্যাচ
Batch 01B ফাইনালাইজ — 0.3 কোডের CI সবুজ করা (ও লকফাইল কমিট), তারপর ম্যানুয়াল টেস্ট: নতুন ইমেইলে সাইন-আপ → লিংক ক্লিক → ড্যাশবোর্ডে workspace + ৩০ ট্রায়াল ক্রেডিট
তারপর Batch 01C — টাস্ক 0.4–0.6 (ক্রেডিট লেজার, events/audit, অ্যাডমিন + 2FA)
তারপর Batch 02 — Phase 1 (LLM রাউটার, জব কিউ)

## খোলা সিদ্ধান্ত / ব্লকার
- ফেজ 2a-র আগে: SERP প্রোভাইডার ডিপোজিট (PLAN §৩.৭) — Bilal-এর সম্মতি অপেক্ষমান
