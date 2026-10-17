# PROGRESS

> প্রতিটি ব্যাচ শেষে এজেন্ট এটা আপডেট করে। নতুন সেশনে `CLAUDE.md`-এর পরেই এটা পড়তে হবে।

## সম্পন্ন ব্যাচ
- **01A (টাস্ক 0.1, 0.7, 0.8 আংশিক):** Next.js 16 (App Router, TS strict) + Tailwind 4 + ESLint + Vitest; `src/lib/slugify.ts` (৩৩ টেস্ট, সাল-স্ট্রিপ), `src/lib/languages.ts`; GitHub Actions CI (lint/typecheck/test/build)। লোকালি চারটা কমান্ড সবুজ। সিদ্ধান্ত: TypeScript 5-এ পিন (TS 7 টাইপস্ক্রিপ্ট-eslint-এর সাথে চলে না); shadcn/ui ও Playwright স্মোক UI-ওয়ালা ব্যাচে (01B) যোগ হবে; `languages` DB সিড 01B-র মাইগ্রেশনে।
- **01B (টাস্ক 0.2, 0.3) — মালিক-যাচাইকৃত:** মাইগ্রেশন `0001_core_schema.sql` (`languages` es/en সিড, `profiles`, `workspaces`, `workspace_members`, `trials`, সাইন-আপ ট্রিগার, সব টেবিলে RLS); `rls_0001.sql` আসল Supabase-এ ৩৫/৩৫ পাস। অ্যাপ: ম্যাজিক-লিংক লগইন + Turnstile (Supabase-এর নিজস্ব Captcha দিয়ে যাচাই), `/auth/callback`, `proxy.ts` সেশন-রিফ্রেশ, `/dashboard`। Vercel বিল্ড সবুজ; নতুন ইউজার → workspace + ৩০ ট্রায়াল ক্রেডিট দেখা গেছে।
- **01C (টাস্ক 0.4, 0.5, 0.6) — মালিক-যাচাইকৃত (১৫ অক্টোবর):** `rls_0002_0004.sql` আসল Supabase-এ ৭৫/৭৫ পাস, CI/Vercel সবুজ, `/admin` থেকে ক্রেডিট গ্রান্ট কাজ করছে।
  - **0.4 — `0002_credit_ledger.sql`:** append-only `credit_ledger` (শুধু `held → committed|released` বদলায়, ডিলিট নিষিদ্ধ), `credit_reserve / commit / release / adjust / balance`; idempotency-key দিয়ে ইডেম্পোটেন্ট, ওয়ার্কস্পেস-প্রতি advisory lock; শুধু `service_role` চালায়। ৫০ প্যারালাল reserve ওভারড্রাফট করে না (`credit_concurrency.sh`)। এরর-কোড: `PM001` insufficient_credits, `PM002` idempotency_conflict, `PM003` invalid_state, `PM004` not_found।
  - **0.5 — `0003_events_audit.sql` + `src/lib/events.ts`:** `events` (কাঁচা; ক্লায়েন্টের অ্যাক্সেস নেই), append-only `admin_audit`, `purge_old_events(days ≥ 14)`, `signup`/`email_verified` DB-ট্রিগার থেকে; `track()` Zod-ভ্যালিডেটেড, ইমেইল-জাতীয় props ফেরত দেয়, কখনো থ্রো করে না।
  - **0.6 — `0004_admin.sql` + `/admin`:** `requireAdmin()` গার্ড (লগইন → অ্যাডমিন-রোল নয় হলে 404 → TOTP `aal2` না থাকলে `/admin/mfa`), `/admin/users` (সার্চ, পেজিনেশন, ব্যালান্স), superadmin-এর অডিটেড ক্রেডিট গ্রান্ট/রিভোক (`admin_credit_adjust`: ডাটাবেসেই superadmin পুনঃযাচাই; লেজার + অডিট একই ট্রানজ্যাকশনে)।
  - সিদ্ধান্ত: ক্রেডিট গ্রান্ট শুধু superadmin; reserve-এর পরিমাণই commit হয়; `admin_audit` শুধু পরিবর্তনমূলক অ্যাকশন লগ করে; ড্যাশবোর্ড এখনো `trials.granted_credits` দেখায় (লেজার-ব্যালান্স পরের UI-ব্যাচে)।

## চলমান ব্যাচ
**Batch 02 — Phase 1: LLM অ্যাডাপ্টার/রাউটার/কস্ট ট্র্যাকার, `model_registry`, জব কিউ + pg_cron tick, অ্যাডমিন জব/এরর লগ।** SQL অংশ লোকাল Postgres 16-এ যাচাইকৃত; অ্যাপ-কোড **অযাচাইকৃত** (এজেন্টের ওয়ার্কস্পেসে npm ব্লক) — প্রথম যাচাই GitHub Actions/Vercel। আসল LLM প্রোভাইডারের সাথে এখনো কোনো কল হয়নি: অ্যাডাপ্টারগুলো ডক-অনুযায়ী লেখা, অ্যাডমিনের "llm" টেস্ট জবই প্রথম আসল প্রমাণ।

- **`0005_llm_registry.sql`:** `model_registry` + তারিখ-ভিত্তিক `model_prices` (মডেল-আইডি ও দাম কোডে নেই, শুধু ডাটাবেসে), `llm_routes` (টাস্ক → ফলব্যাক চেইন, PLAN §১৩-র ক্লাস অনুযায়ী), `llm_calls` (প্রতিটি প্রোভাইডার-অ্যাটেম্পটের টোকেন/খরচ/লেটেন্সি/এরর-কোড), `credit_rates` (এখন শুধু `test_job` = ১), `feature_flags` (`unsplash_provider` OFF, `llm_kill_switch`, `llm_budget_guard`), `llm_budget_check()`, `admin_llm_usage()`, `purge_old_llm_calls()`। সব সার্ভার-অনলি (RLS চালু, ক্লায়েন্টের কোনো অ্যাক্সেস নেই)।
  - **দাম অফিশিয়াল পেজের সাথে মেলানো (১৫ অক্টোবর):** Anthropic — Haiku 5.5 `0.10/0.50` (প্রম্পট ১০০k টোকেনের ওপরে `0.50/2.50`), Sonnet 5.5 `2/10`, Opus 5.5 `4/20`; Gemini — 3.8 Flash `0.75/3.75` (৩১ ডিসেম্বর ২০২৬ পর্যন্ত; ১ জানুয়ারি ২০২৭ থেকে `1.50/7.50`, দ্বিতীয় সারি আগেই বসানো), 3.5 Flash-Lite `0.30/2.50`; OpenAI — `gpt-6.1-sol` `2/10`, `gpt-6-luna` `0.10/0.50`। PLAN §১৩-র "Haiku `$১/$৫`" লাইনটা পুরনো (Haiku 4.5-এর); রেজিস্ট্রিই সঠিক।
  - **খোলা:** OpenAI-র লং-কনটেক্সট টিয়ারের (`gpt-6.1-sol` `4/15`, `gpt-6-luna` `0.20/0.75`) থ্রেশহোল্ড পেজে লেখা নেই, তাই প্রয়োগ হচ্ছে না (দুটোই ফলব্যাক-চেইনের শেষে, ঝুঁকি কম); জানা গেলে `model_prices`-এ নতুন `effective_from`-সহ সারি দাও। Anthropic-এর cache-write টোকেন (সাধারণ ইনপুটের ১.২৫×) আমরা সাধারণ ইনপুট রেটে গুনছি — আসল খরচ সামান্য বেশি হতে পারে; এখনো প্রম্পট-ক্যাশ ব্যবহার করি না, তাই এখন প্রভাব নেই।
- **`0006_jobs.sql`:** `jobs` + `job_enqueue` (জব ও ক্রেডিট-hold **একই ট্রানজ্যাকশনে**, idempotency-key সহ), `job_claim` (`FOR UPDATE SKIP LOCKED` + প্রোভাইডার-ভিত্তিক কনকারেন্সি সীমা), `job_heartbeat`, `job_complete` (hold commit), `job_fail` (ব্যাকঅফসহ রিট্রাই; শেষে `dead` = ডেড-লেটার কিউ + hold release), `job_watchdog` (লিজ-মেয়াদোত্তীর্ণ জব আবার কিউতে/`dead`-এ, এতিম hold release — 01C-তে বাকি রাখা watchdog এটাই), `job_cancel`, `job_retry_dead`, অডিটেড `admin_job_retry/cancel/enqueue_test_job`, `purge_old_jobs()`। লিজ-হারানো ওয়ার্কার জব complete/fail করতে পারে না (`PM003`), তাই hold দুইবার commit হয় না।
- **অ্যাপ (নতুন ডিপেন্ডেন্সি নেই):** `src/modules/llm` — `callLlm()` LLM-এর একমাত্র দরজা: কিল-সুইচ/বাজেট গেট → ডাটাবেস থেকে রুট → ফলব্যাক চেইন → আউটপুট Zod-এ যাচাই → প্রতি অ্যাটেম্পটে `llm_calls`; Anthropic/OpenAI/Gemini অ্যাডাপ্টার; রেসপন্স-বডি বা কী কখনো লগে/এররে যায় না। `src/modules/jobs` — `runTick()` (watchdog → claim → run → complete/fail; ৫০ সেকেন্ড হ্যান্ডলার-টাইমআউট)। `/api/jobs/tick` — `CRON_SECRET` Bearer, constant-time, সিক্রেট না থাকলে বা ছোট হলে কাউকে ঢুকতে দেয় না। `/admin/jobs` — কাউন্টার, ডেড-লেটার/সব জব, রিট্রাই/ক্যান্সেল, ২৪ ঘণ্টার LLM খরচ, বাজেট-অবস্থা, টেস্ট-জব বোতাম। `/admin/users`-এ শুধু নেভিগেশন লিংক বদলেছে।
- **টেস্ট:** `supabase/tests/rls_0005_0006.sql` — লোকালি **১১৭/১১৭ পাস**। `supabase/tests/jobs_concurrency.sh` (SQL Editor-এ নয়, `DATABASE_URL` দিয়ে): ৪০ প্যারালাল ক্লেইমে কোনো জব দুইবার ক্লেইম হয়নি, প্রোভাইডার-সীমা (৪) ভাঙেনি, একই কী ×৩০ = ১টা জব + ১টা hold, প্রতিযোগিতায় ওভারড্রাফট নেই। আগের ৩৫/৭৫ টেস্ট ও `credit_concurrency.sh` এখনো পাস। Vitest: `cost`, `json`, `auth`, `handlers`, `job-schemas` টেস্ট — অযাচাইকৃত, CI-তে প্রথম চলবে; তবে খরচ-হিসাব, JSON-এক্সট্রাকশন ও cron-auth-এর ২৩টা চেক নোডে সরাসরি চালিয়ে পাস।

### Batch 02-র সিদ্ধান্ত (আপত্তি থাকলে বলো)
- ফলব্যাক চেইন `llm_routes`-এ ডাটা হিসেবে আছে; বদলাতে কোড লাগে না (অ্যাডমিন-এডিটর পরে)। ক্রস-জাজ টাস্কে (`map_audit`, `qa_cross_judge`) কলার `avoidProvider` দেয়, যাতে প্রডিউসার ও জাজ আলাদা প্রোভাইডার হয়।
- `llm_budget_guard` ডিফল্টে **বন্ধ** (সীমা: দৈনিক ১০ ডলার, UTC)। চালু করতে: `update public.feature_flags set enabled = true where key = 'llm_budget_guard';` — সীমা বদলাতে: `update public.feature_flags set rules = '{"daily_usd": 5}' where key = 'llm_budget_guard';`। `llm_kill_switch` চালু করলে সব LLM কল সাথে সাথে বন্ধ।
- জব retry/cancel: superadmin ও support। টেস্ট-জব: শুধু superadmin, শুধু নিজের workspace-এ (নিজের ক্রেডিট খরচ হয়)। সব অডিটেড।
- জবের ক্রেডিট `credit_rates` থেকে আসে; এখন শুধু `test_job` = ১। বাস্তব রেট (ম্যাপ = `১০ + ৫ × ceil(আইটেম/২৫)` ইত্যাদি) ফেজ ২/৭-এ।
- ক্রন: Vercel Cron নয়, Supabase `pg_cron → pg_net → /api/jobs/tick`, প্রতি মিনিট (PLAN §১২)। `supabase/ops/schedule_jobs.sql` মাইগ্রেশন নয় (এতে সাইটের URL ও সিক্রেট বসে): রিপোতে প্লেসহোল্ডারসহই থাকবে, **আসল সিক্রেট কখনো GitHub-এ নয়**; Supabase Vault-এ জমা হয়। এটা `purge_old_events` (৩০ দিন), `purge_old_llm_calls` (৯০ দিন), `purge_old_jobs` (৩০ দিন)-এর দৈনিক শিডিউলও বসায়।

### মালিকের করণীয় (Batch 02)
1. জিপের ফাইলগুলো আপলোড → Commit। GitHub Actions/Vercel সবুজ হওয়া পর্যন্ত অপেক্ষা (লাল হলে এরর পেস্ট করো)।
2. Supabase SQL Editor-এ **ক্রমানুযায়ী** Run: `0005_llm_registry.sql` → `0006_jobs.sql`; তারপর `rls_0005_0006.sql` → শেষ সারি `ALL CHECKS | 117 of 117 passed | true` হওয়া চাই।
3. Vercel → Environment Variables: `CRON_SECRET` (১৬+ অক্ষরের র‍্যান্ডম) আর **অন্তত একটা** LLM কী (`ANTHROPIC_API_KEY` সুপারিশকৃত; `OPENAI_API_KEY`/`GEMINI_API_KEY` ঐচ্ছিক ফলব্যাক)। প্রোভাইডারের ড্যাশবোর্ডে মাসিক খরচ-সীমা বসিয়ে নিও। তারপর **Redeploy**।
4. `supabase/ops/schedule_jobs.sql` SQL Editor-এ পেস্ট করে **শুধু ওই দুটো `EDIT ME` লাইন** (সাইট URL, একই `CRON_SECRET`) বদলিয়ে Run। শেষে ৪টা সারি আসবে, সবকটা `active = true`।
5. ম্যানুয়াল টেস্ট (`/admin/jobs`, superadmin): ➊ "ok" জব → ১ মিনিটের মধ্যে `succeeded` ➋ "fail" জব → একবার রিট্রাই (`queued`), তারপর `dead` ➌ "fail_permanent" → সরাসরি `dead` → "Retry" চাপলে আবার `queued` ➍ "llm" জব → `succeeded`, "LLM usage"-এ খরচ দেখা যায়, আর `/admin/users`-এ নিজের ব্যালান্স থেকে ১ ক্রেডিট কমে।
6. (ঐচ্ছিক) `DATABASE_URL='…' bash supabase/tests/jobs_concurrency.sh` → `RESULT: ALL SCENARIOS PASSED`।
7. (সুপারিশ) `llm_budget_guard` চালু করো (ওপরের SQL)।

## ডিজাইন ব্যাচ (UI রিস্টাইল, আচরণ অপরিবর্তিত)
- রঙের ভাষা: **লেগুন টিল** (ম্যাপ/স্ট্রাকচার/নেভিগেশন), **পিন রোজ** (প্রতি স্ক্রিনে একটাই মূল অ্যাকশন), **গাঁদা হলুদ** (ক্রেডিট)। বাকি সব ঠান্ডা মিস্ট-ধূসর। লাইট ও ডার্ক (`prefers-color-scheme`) দুটোই আছে; WCAG কনট্রাস্ট স্ক্রিপ্টে যাচাই (০ ফেল)।
- ফন্ট: Bricolage Grotesque (শিরোনাম/বড় সংখ্যা), Instrument Sans (বাকি সব), Google Fonts থেকে; লোড না হলে ফলব্যাক স্ট্যাক।
- একটাই সিগনেচার: ম্যাপ-বোর্ডে হার্ড অফসেট শ্যাডো। সব স্টাইল `globals.css`-এ `pm-` ক্লাস; পেজে Tailwind ইউটিলিটি নেই।
- নতুন: `src/components/brand.tsx` (লোগো, কয়েন), `public/contours-*.svg`, `src/app/icon.svg`, অ্যাডমিন শেল (সাইডবার + সাইন-আউট)।
- পরিবর্তিত পেজ: হোম, লগইন, ড্যাশবোর্ড, অ্যাডমিন users/jobs/mfa। কোনো ডাটা/অ্যাকশন/অথ লজিক বদলায়নি।
- **যাচাই:** npm বন্ধ বলে `typecheck/lint/build` চালানো যায়নি (প্রেটিয়ার দিয়ে সিনট্যাক্স পার্স হয়েছে)। CI/Vercel-ই প্রথম পরীক্ষা। প্রিভিউ স্ক্রিনশট Inter ফন্টে তোলা, আসল ফন্ট দেখা যায়নি।

## Batch 03 — Phase 2a: ডেডুপ-ইঞ্জিন + ইভ্যাল (অফলাইন, কোনো DB/API-কী ছাড়া)
**সিদ্ধান্ত (মালিক আমার ওপর ছেড়েছেন):** (১) স্প্যানিশ লোকেল `es-MX` থাকছে। (২) SERP ডিপোজিট আমি করতে পারি না; তাই `SerpProvider` ইন্টারফেস + DataForSEO অ্যাডাপ্টার বানানো হলো, কিন্তু **লাইভ যাচাই বাকি** (ফিক্সচার-টেস্ট মাত্র)। ডিপোজিট ছাড়া গোল্ড-সেটের "SERP-পাস" চলে না, তাই সেট এখন `provisional`।

**কী আছে (`src/modules/topical-map/`):**
- `normalize.ts` + `lexicon.ts` (S3): ডায়াক্রিটিক-ফোল্ড, বহুবচন, স্টপওয়ার্ড, সমার্থক (cabello/pelo, fáciles/sencillos/simples, xv años = quinceañera; `chino` শুধু es-MX), টোকেন-সেট কী। `sin` স্টপওয়ার্ড নয়।
- `modifiers.ts`: পরস্পরবিরোধী মডিফায়ার (ninas≠niños, corto≠largo, 5≠10 minutos, con≠sin plancha)। এটা **ভেটো**: কোসাইন যত বেশিই হোক, মার্জ হয় না।
- `compare.ts` + `dedup.ts` (S4): ক্রম = exact কী → ভেটো → parent_child (একটার কনটেন্ট অন্যটার সুপারসেট; কখনো অটো-মার্জ নয়) → একই কনটেন্ট → কোসাইন থ্রেশহোল্ড (`high 0.88`, `low 0.6`) → বর্ডারলাইন জাজে। ফল = `primary + variants[]` (প্রাইমারি: বেশি ডিমান্ড-টিয়ার, তারপর ছোট ফ্রেজ, তারপর বর্ণানুক্রম; ইনপুট-ক্রমে ফল বদলায় না)।
- `judge.ts`: LLM ইনটেন্ট-জাজ (৩০ জোড়া/কল, Zod-যাচাই; ভুল/অনুপস্থিত উত্তর = আলাদা রাখা, কখনো মার্জ নয়)। `callJson` ইনজেক্টেড; অ্যাপে `callLlm({task:"intent_judge"})` দিয়ে বাঁধা হবে (রুটটি ০০০৫-এ আছে)।
- `serp.ts`: `SerpProvider`, URL-ক্যানোনিক্যালাইজ, টপ-১০ ওভারল্যাপ → verdict (৪+ = same, ২–৩ = related, ০–১ = different), DataForSEO অ্যাডাপ্টার (location=Mexico, language=es)।
- `facets.ts` (S1 + S2 প্রম্পট ও Zod স্কিমা, `toCandidates` ক্লিনআপ)। `embed.ts`: অফলাইন `lexicalEmbedder` (বেসলাইন; প্রোডাকশন এমবেডার নয়)।
- ইভ্যাল: `eval/golden/es-peinados.jsonl` (১৫১ জোড়া: same ৫১, parent_child ৩৭, related ২৩, different ৪০; dev/test স্প্লিট), `eval/floors.json`, `pnpm eval:dedup [--split dev|test] [--verbose]`। `pnpm test`-এও রিগ্রেশন-চেক আছে (test-স্প্লিটে precision ≥ ০.৯৫, recall ≥ ০.৮০; নইলে CI লাল)।

**অফলাইন বেসলাইনের ফল (এই মেশিনে চালানো):** dev: precision ১০০%, recall ৮৮.৫%; test: precision ১০০%, recall ৮৮.০%। অর্থাৎ ভুল-মার্জ ০টি; মিস-মার্জ ৬টি (সমার্থক যেটা লেক্সিকনে নেই: bonitos/lindos, evitar frizz/encrespamiento, trabajo/oficina, cuidado/cuidar, quitar/eliminar, los 90/años 90)। এগুলো আসল এমবেডিং + LLM জাজে ধরার কথা; সেটা এখনো মাপা হয়নি।

**সৎ সীমাবদ্ধতা — পড়ে নিও:**
1. **গোল্ড-সেট `provisional`।** প্ল্যান ৩.১০-এর প্রোটোকল (আসল ম্যাপ-রানের প্রার্থী-পুল থেকে স্যাম্পল, দুই স্বাধীন মডেল, SERP-তৃতীয়-পাস) এখানে চালানো যায়নি: API-কী ও SERP অ্যাকাউন্ট নেই, আসল ম্যাপ-রানও হয়নি। জোড়াগুলো আমি (এক লেবেলার) প্ল্যানের ফ্যাসেট-ট্যাক্সোনমি থেকে বানিয়েছি। তাই ১০০%/৮৮% "নির্ভরযোগ্য সূচক" নয়, শুধু রিগ্রেশন-বেসলাইন। আমি নেটিভ নই; es-MX শব্দে ভুল থাকতে পারে।
2. **টিউনিং-দূষণ:** প্রথম রানে dev ও test দুটোর মিসই দেখেছি; এরপর শুধু সাধারণ নিয়ম বদলেছি (বহুবচন-নিয়ম, `ir` জেনেরিক, সমার্থক-লুকআপ)। তাই test-স্প্লিট পুরোপুরি "অদেখা" নয়।
3. থ্রেশহোল্ড (`0.88/0.6`) লেক্সিক্যাল এমবেডারের জন্য; আসল এমবেডিং মডেলে আবার টিউন করতে হবে।
4. `DataForSEO` অ্যাডাপ্টার লাইভ যাচাই হয়নি।
5. **এই ব্যাচে DB নেই:** `map_runs`/`kw_candidates` টেবিল ও জব-স্টেজ হ্যান্ডলার Batch 04-এ (প্রতিটি টেবিলে RLS + RLS-টেস্ট সহ)। এমবেডিং প্রোভাইডার (LLM মডিউলে এমবেডিং কল নেই) Batch 04-এ।
6. `package.json`-এ নতুন devDependency `tsx` (শুধু `eval:dedup` স্ক্রিপ্ট চালাতে; কারণ: TS স্ক্রিপ্ট সরাসরি চালানোর সবচেয়ে হালকা উপায়)। `pnpm-lock.yaml` এখনো পুরনো (লকফাইল ঋণ — নিচে দেখো)।
7. **যাচাই:** npm বন্ধ, তাই `pnpm lint/test/build` চালাতে পারিনি। বদলে: ৩৭টি টেস্ট একটি ছোট vitest-সদৃশ রানারে চালিয়েছি (৩৭/৩৭ পাস), আর `tsc --strict --noUncheckedIndexedAccess` দিয়ে নতুন ফাইলগুলো টাইপচেক করেছি (০ এরর)। ESLint চালানো যায়নি। CI/Vercel-ই আসল প্রথম পরীক্ষা; `pnpm test`-এ vitest-এর `it.each`-এর টাইটেল ফরম্যাট শিমের থেকে আলাদা হতে পারে, ফলে কোনো প্রভাব নেই।

### মালিকের করণীয় (Batch 03)
1. জিপের ফাইলগুলো আপলোড → Commit; CI/Vercel সবুজ হওয়া পর্যন্ত অপেক্ষা (লাল হলে এরর পেস্ট করো)।
2. (ঐচ্ছিক, কম্পিউটারে `pnpm install` শেষে) `pnpm eval:dedup --verbose` চালিয়ে ফল মিলিয়ে দেখো।
3. সময় পেলে একজন স্প্যানিশ-জানা মানুষকে `eval/golden/es-peinados.jsonl`-এর ১৫১টি জোড়া দেখিয়ে নিও (প্ল্যানে ঐচ্ছিক নেটিভ স্পট-চেক সুপারিশ আছে)। ভুল লেবেল পেলে `label` বদলে `status` `confirmed` করো।

## পরের ব্যাচ
**Batch 04 (Phase 2b):** ম্যাপ-টেবিল (`projects`, `map_runs`, `facets`, `kw_candidates`, `kw_pairs`) + RLS + RLS-টেস্ট (০০০৭), এমবেডিং প্রোভাইডার (প্রোডাকশন এমবেডার; থ্রেশহোল্ড রি-টিউন), S1→S4 জব-স্টেজ (চাঙ্কড, রিজিউমেবল, ক্রেডিট-হোল্ডসহ), অ্যাডমিন থেকে ম্যাপ-রান চালানো ও গোল্ড-সেট ব্যাচ-লেবেলিং CLI।
**যা লাগবে (Batch 04-এর আগে নয়, শুরুতে জানিও):** অন্তত একটি এমবেডিং-সক্ষম কী (OpenAI/Gemini) — কী থাকলে আসল ম্যাপ-রান ও দুই-মডেল গোল্ড-লেবেলিং চলবে। SERP-ডিপোজিট না দিলেও এগোনো যায় (গোল্ড `provisional`, SERP-পাস বাদ)।

## খোলা সিদ্ধান্ত / ব্লকার
- **লকফাইল ঋণ:** `pnpm-lock.yaml` এখনো পুরনো; সাময়িক ওয়ার্কঅ্যারাউন্ড `.npmrc` (`frozen-lockfile=false`) ও CI-তে `--no-frozen-lockfile`। যেকোনো কম্পিউটারে `pnpm install` চালিয়ে নতুন `pnpm-lock.yaml` কমিট করো, তারপর `.npmrc` মুছে CI-তে `--frozen-lockfile` ফেরাও।
- `@supabase/ssr` 0.6.1-এ পিন (নতুন সংস্করণ আছে); লকফাইল ঠিক হলে আপগ্রেড বিবেচনা।
- shadcn/ui ও Playwright স্মোক এখনো যোগ হয়নি; অ্যাডমিন UI বাড়ার সময় (01C-র পর) যোগ হবে।
- ফেজ 2a-র আগে: SERP প্রোভাইডার ডিপোজিট (PLAN §৩.৭) — Bilal-এর সম্মতি অপেক্ষমান
