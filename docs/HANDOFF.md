# PinMentor — হ্যান্ডঅফ (নতুন চ্যাটে কাজ চালিয়ে যাওয়ার জন্য)

> আপডেট: ২০২৬-১০-১৭, Batch 04 শেষে। নতুন চ্যাটে এই ফাইল + সর্বশেষ রিপো-জিপ + `docs/PLAN.md` + `CLAUDE.md` + `sandbox-tools.zip` দাও।
> প্রথমে `CLAUDE.md`, `docs/PROGRESS.md`, `docs/PLAN.md` পড়ো, তারপর এই ফাইলের "পরের কাজ" থেকে শুরু করো।

## ১. প্রজেক্ট এক লাইনে
PinMentor = মাল্টি-ইউজার SaaS: টপিক → যাচাইকৃত টপিক্যাল ম্যাপ (১০০–৫০০+ আর্টিকেল) → ব্যাচে আর্টিকেল → WordPress পাবলিশ/শিডিউল → Pinterest পিন।
স্ট্যাক: Next.js 16 App Router, TypeScript strict, Supabase (Postgres, Auth, RLS, pg_cron, pg_net), Tailwind 4, Vercel, pnpm, Vitest। ডক বাংলায়; কোড, কমেন্ট, কমিট মেসেজ ইংরেজিতে।

## ২. মালিকের সাথে কাজের নিয়ম (স্থায়ী)
- মালিক GitHub ওয়েব UI-তে **ড্র্যাগ-ড্রপ** আপলোড করেন। তাই **শুধু নতুন/বদলানো ফাইল**, ১০০-র কম, রিপো-পাথসহ **জিপে**। ডিলিটের তালিকা আলাদা। `.github`-এর মতো ডটফোল্ডার ড্র্যাগ হয় না: ওয়েব এডিটরে হাতে বদলাতে বলো।
- SQL আলাদা ফাইলে (`supabase/migrations/000N_*.sql`), মালিক Supabase SQL Editor-এ **ক্রমানুসারে, প্রতিটি একবারই** চালান। প্রয়োগ হয়ে যাওয়া মাইগ্রেশন **কখনো এডিট নয়**। টেস্ট-SQL (`supabase/tests/rls_*.sql`) চালিয়ে শেষ সারি `ALL CHECKS | N of N passed | true` চান।
- প্রতি ব্যাচ শেষে `docs/PROGRESS.md` আপডেট, মালিকের করণীয় ক্রমানুসারে লেখা। মালিক বাংলায় লেখেন; উত্তর বাংলায়, ছোট ও স্পষ্ট। আগের ব্যাচের কাজ নিশ্চিত না হওয়া পর্যন্ত পরের ব্যাচ নয় (মালিক "সব ঠিক আছে, পরের ধাপে যাও" বললে নিশ্চিত)।
- সিক্রেট (কী, `.env`) কখনো কমিট, চ্যাট বা লগে নয়।
- **সততা:** যা চালিয়ে দেখোনি তা "যাচাইকৃত" বোলো না। সীমাবদ্ধতা PROGRESS.md-তে লেখো।
- ডিজাইনের মালিকের পছন্দ: সুন্দর, রঙের স্কিম ভেবে করা; স্বয়ংক্রিয় টেমপ্লেট-চেহারা নয়।

## ৩. এখন পর্যন্ত কী হয়েছে
| ব্যাচ | বিষয় | অবস্থা |
|---|---|---|
| 01/01B/01C | কোর স্কিমা, প্রোফাইল/ওয়ার্কস্পেস, RLS, ক্রেডিট লেজার, events/admin_audit, অ্যাডমিন (users, ক্রেডিট গ্রান্ট), ম্যাজিক-লিংক লগইন + Turnstile, 2FA | মালিক আসল Supabase-এ যাচাই করেছেন (35/35, 75/75) |
| 02 | LLM রেজিস্ট্রি (`callLlm`), জব কিউ + ক্রন, `/admin/jobs` | মালিক নিশ্চিত: 117/117 ও অ্যাডমিন/জবস ঠিক |
| ডিজাইন | রঙ/টাইপ সিস্টেম (`globals.css`, `pm-` ক্লাস), হোম, লগইন, ড্যাশবোর্ড, অ্যাডমিন শেল | জিপ দেওয়া হয়েছে; Vercel বিল্ড মালিক দেখে নিশ্চিত করেননি |
| 03 | ডেডুপ-ইঞ্জিন (S3/S4) + ইভ্যাল + গোল্ড-সেট (`provisional`) + `SerpProvider` | জিপ দেওয়া হয়েছে; CI সবুজ কি না মালিক জানাননি |
| 04 | API কী অ্যাডমিন পেজ (`/admin/integrations`), `platform_secrets` (০০০৭) | জিপ দেওয়া হয়েছে; ০০০৭ ও `rls_0007.sql` (২৫/২৫ প্রত্যাশিত) মালিকের চালানো বাকি |

মালিকের বাকি করণীয় প্রতিটি ব্যাচের জন্য `docs/PROGRESS.md`-এর "মালিকের করণীয়" অংশে। **নতুন চ্যাটের প্রথম কাজ:** মালিককে জিজ্ঞেস করো ডিজাইন, Batch 03 ও Batch 04-এর আপলোড ও CI/Vercel সবুজ কি না এবং `rls_0007.sql` ফল কী; লাল হলে এরর নিয়ে আগে ঠিক করো।

## ৪. রিপো-ম্যাপ (গুরুত্বপূর্ণ ফাইল)
- `supabase/migrations/0001…0007` — স্কিমা। `supabase/tests/` — SQL টেস্ট ও কনকারেন্সি স্ক্রিপ্ট; `supabase/tests/local/supabase_shim.sql` — লোকাল Postgres-এ Supabase-এর নকল (শুধু টেস্টের জন্য)। `supabase/ops/schedule_jobs.sql` — pg_cron শিডিউল (মালিক চালিয়েছেন)।
- `src/modules/llm/` — LLM-এর **একমাত্র দরজা** `callLlm()` (মডেল/দাম/রুট DB-তে; কিল-সুইচ, বাজেট-গার্ড; ফলব্যাক চেইন)। `src/modules/jobs/` — জব কিউ ক্লায়েন্ট; `/api/jobs/tick`।
- `src/modules/topical-map/` — S1/S2 প্রম্পট ও স্কিমা (`facets.ts`), S3 (`normalize.ts`, `lexicon.ts`), মডিফায়ার-ভেটো (`modifiers.ts`), `compare.ts`, `dedup.ts`, `judge.ts` (LLM ইনটেন্ট-জাজ, `callJson` ইনজেক্টেড), `serp.ts`, `embed.ts` (অফলাইন লেক্সিক্যাল বেসলাইন), `eval.ts`। ইভ্যাল: `eval/golden/es-peinados.jsonl`, `eval/floors.json`, `pnpm eval:dedup`।
- `src/lib/secrets/` — `providers.ts`, `crypto.ts` (AES-256-GCM, `ENCRYPTION_KEY`), `resolver.ts` (পিওর) / `resolve.ts` (DB-সংযুক্ত), `test-connection.ts`, `schemas.ts`।
- `src/lib/admin/` — `guard.ts` (`requireAdmin()`: role → 2FA aal2; অ-অ্যাডমিন 404), `roles.ts` (`canAdjustCredits`, `canManageJobs`, `canEnqueueTestJobs`, `canManageSecrets`)।
- `src/app/admin/{users,jobs,integrations,mfa}`, `admin-nav.tsx` (`AdminShell`, `current="users|jobs|keys"`)। `src/components/brand.tsx`।
- ডিজাইন সিস্টেম: `src/app/globals.css` — টোকেন (লেগুন টিল `--brand`, পিন রোজ `--pin`, গাঁদা `--gold`), `pm-` ক্লাস, লাইট/ডার্ক অটো। নতুন UI-তে Tailwind ইউটিলিটি নয়, `pm-` ক্লাস; দরকারে `globals.css`-এর `@layer components`-এ যোগ করো।

## ৫. মূল প্রযুক্তিগত তথ্য
- **ক্রেডিট লেজার:** append-only, held→committed|released, idempotency key, ওয়ার্কস্পেস-ভিত্তিক advisory lock। এরর: `PM001` insufficient_credits, `PM002` idempotency_conflict, `PM003` invalid_state, `PM004` not_found।
- **জব কিউ:** `FOR UPDATE SKIP LOCKED`, লিজ, watchdog, dead-letter, প্রোভাইডার-ভিত্তিক কনকারেন্সি; জবের সাথে ক্রেডিট-হোল্ড। pg_cron → pg_net → `/api/jobs/tick` (Bearer `CRON_SECRET`)।
- **অ্যাডমিন অ্যাকশন প্যাটার্ন:** `requireAdmin()` → রোল-চেক → Zod → `createAdminClient().rpc("admin_*", {p_admin, …, p_ip})` (SQL ফাংশন আবার রোল চেক করে ও `admin_audit` লেখে) → `revalidatePath` → `redirect(...?flash=code)`। ক্লায়েন্টকে কখনো ভেতরের এরর/সিক্রেট ফেরত নয়।
- **LLM টাস্ক-রুট (০০০৫-এ সিডেড):** `facet_generation`, `keyword_generation`, `intent_judge`, `map_audit`, `qa_cross_judge`, `title_generation`, `article_write`, `article_write_premium`, `research_outline`, `pin_copy`, `image_query`, `test_echo`। ক্রস-জাজ টাস্কে `avoidProvider` দিতে হয়।
- **ডেডুপ ক্রম (`compare.ts`):** exact কী → মডিফায়ার-ভেটো (niñas≠niños, corto≠largo, 5≠10 minutos, con≠sin) → parent_child (সুপারসেট; কখনো অটো-মার্জ নয়) → একই কনটেন্ট → কোসাইন (`high 0.88`, `low 0.6` — **লেক্সিক্যাল এমবেডারের জন্য**) → বর্ডারলাইন জাজ। ভুল/অনুপস্থিত জাজ-উত্তর = আলাদা রাখা।
- **কী রিজলভার:** অ্যাডমিন-পেজের এনক্রিপ্টেড কী → না থাকলে env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DATAFORSEO_LOGIN/PASSWORD`)। ৬০ সেকেন্ড ক্যাশ।
- স্প্যানিশ লোকেল ডিফল্ট `es-MX` (মালিক আমার সিদ্ধান্তে ছেড়েছেন)। স্লাগে সাল নয়, আর্টিকেলে দাম/ডিসকাউন্ট নয় (CLAUDE.md)।

## ৬. পরের কাজ: Batch 05 (Phase 2b)
শুরুর শর্ত: মালিক `/admin/integrations`-এ অন্তত একটি এমবেডিং-সক্ষম কী (OpenAI বা Gemini) ও একটি চ্যাট-মডেল কী যোগ করে "Test connection" সবুজ পেয়েছেন। (DataForSEO ঐচ্ছিক; ডিপোজিট ছাড়া গোল্ড-সেট `provisional`।)
১. **ম্যাপ-টেবিল (০০০৮):** `projects`, `map_runs`, `facets`, `kw_candidates` (embedding `vector(1536)`), `kw_pairs` (জাজ-ক্যাশ), `golden_pairs` — PLAN §১১-এর স্কিমা। প্রতিটিতে `workspace_id` + RLS + RLS-টেস্ট (`rls_0008.sql`)। pgvector এক্সটেনশন Supabase-এ চালু করতে হবে (লোকালে শিম/স্কিপ ভেবে নাও)।
২. **এমবেডিং:** `model_registry`-তে এমবেডিং-মডেল + দাম (যাচাই করা, তারিখসহ; কোডে হার্ডকোড নয়), `embed()` কী রিজলভার দিয়ে; খরচ লগ; থ্রেশহোল্ড আসল এমবেডিংয়ে গোল্ড-সেটের dev স্প্লিটে রি-টিউন।
৩. **S1→S4 জব-স্টেজ:** চাঙ্কড (<৬০ সেকেন্ড), রিজিউমেবল, ক্রেডিট-হোল্ডসহ (`credit_rates`-এ ম্যাপের রেট: `১০ + ৫ × ceil(আইটেম/২৫)`)।
৪. অ্যাডমিন থেকে ম্যাপ-রান চালানো; গোল্ড-সেট লেবেলিং CLI (দুই স্বাধীন মডেল, দ্বিমতে SERP-পাস, বাকি `uncertain`)।
৫. পরে: S5–S10 (ইনটেন্ট/টাইপ, স্কোর, সাইলো, টাইটেল/স্লাগ, ভেরিফিকেশন রিপোর্ট)।

## ৭. খোলা ঋণ ও সতর্কতা
- **লকফাইল ঋণ:** `pnpm-lock.yaml` পুরনো (এই স্যান্ডবক্সে npm বন্ধ ছিল)। সাময়িক: `.npmrc` (`frozen-lockfile=false`) ও CI-তে `--no-frozen-lockfile`। কোনো কম্পিউটারে `pnpm install` চালিয়ে নতুন লকফাইল কমিট, তারপর `.npmrc` মুছে `--frozen-lockfile` ফেরানো। নতুন devDependency `tsx` (Batch 03) ওই লকফাইলেই যাবে।
- `@supabase/ssr` 0.6.1-এ পিন; shadcn/ui ও Playwright স্মোক টেস্ট এখনো যোগ হয়নি।
- গোল্ড-সেট `provisional` (এক লেবেলার, আমি; প্ল্যান ৩.১০-এর প্রোটোকল চলেনি)। test স্প্লিট পুরোপুরি অদেখা নয়। একজন স্প্যানিশ-জানা মানুষকে দিয়ে দেখানো সুপারিশকৃত।
- DataForSEO অ্যাডাপ্টার ও চার প্রোভাইডারের "Test connection" এন্ডপয়েন্ট লাইভ যাচাই হয়নি।
- ম্যাজিক-লিংকের "We could not send the link" (সম্ভবত Supabase বিল্ট-ইন ইমেইল রেট-লিমিট) — মালিক পরে আর উল্লেখ করেননি; নিশ্চিত নয়। দরকারে নিজস্ব SMTP সেটআপ প্রস্তাব করো।
- `/home/claude/work/src/modules/topical-map/vector.ts` নামে একটি অজানা ফাইল আগের সেশনের ওয়ার্কস্পেসে ছিল (আমার লেখা নয়, `embed.ts`-এর সাথে মেলে না, টাইপচেক ভাঙে); জিপে দেওয়া হয়নি। রিপোতে এটা থাকলে মালিককে জিজ্ঞেস করে মুছতে বলো।
- মালিকের Supabase/Vercel সেটআপের তথ্য: রিপো `github.com/pinmentor/app`, ব্রাঞ্চ `main`; Vercel এনভ: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TURNSTILE_SITE_KEY`, `CRON_SECRET`, ও Batch 04 থেকে `ENCRYPTION_KEY`।

## ৮. স্যান্ডবক্সে যাচাইয়ের পদ্ধতি (প্রতি নতুন সেশনে বদলাতে পারে; `sandbox-tools.zip` দেখো)
- **npm/pnpm ইনস্টল ব্লক (৪০৩)** — ঘুরিয়ে চেষ্টা কোরো না। তাই `pnpm lint/typecheck/test/build` চালানো যায় না; মালিককে বলো CI/Vercel-ই প্রথম পরীক্ষা।
- **SQL:** লোকাল Postgres 16 (`pg_ctlcluster 16 main start`; `su postgres -c "psql …"`)। `postgres` ইউজার স্ক্র্যাচপ্যাড পড়তে পারে না, তাই ফাইল কপি করো `/tmp/pgrun`-এ (chmod 755/644)। ডাটাবেস বানাও, `supabase/tests/local/supabase_shim.sql` চালাও, তারপর `000N` মাইগ্রেশন ক্রমে, তারপর টেস্ট। রিপোর `supabase/migrations` ফোল্ডারে বাইরের কোনো ফাইল ঢুকিও না (আগে একটি অতিরিক্ত ফাইল ভুয়া ফেল দিয়েছিল)।
- **TypeScript:** `tsx` গ্লোবাল (`/home/claude/.npm-global/bin`), `zod` **v3.25** `/opt/npm-tools/node_modules`-এ (প্রজেক্টের zod 4-এর `z.uuid()`, `z.url()` এখানে নেই)। টেস্টের জন্য ছোট vitest-সদৃশ শিম (`describe/it/expect` সাবসেট) + `NODE_PATH`। টাইপচেক: গ্লোবাল `tsc` + stub ডিক্লারেশন (next, react, supabase)। প্রিটিয়ার সিনট্যাক্স-পার্সের জন্য।
- **UI প্রিভিউ:** স্ট্যাটিক HTML + `globals.css` (Google Fonts লোড হয় না; Inter দিয়ে প্রতিস্থাপিত) + Playwright/Chromium স্ক্রিনশট (লাইট/ডার্ক, ডেস্কটপ/মোবাইল)।
- ইন্টারনেট: শুধু অনুমোদিত তালিকা (প্যাকেজ রেজিস্ট্রি/GitHub); অন্য সাইটে curl ব্লক।

## ৯. নতুন চ্যাটের শুরুর মেসেজের খসড়া
"এটা PinMentor প্রজেক্ট। সংযুক্ত রিপো-জিপ, `CLAUDE.md`, `docs/PROGRESS.md`, `docs/PLAN.md`, `docs/HANDOFF.md` ও `sandbox-tools.zip` আছে। আগে ওগুলো পড়ো। Batch 03/04 আপলোড ও যাচাইয়ের ফল: [এখানে লিখুন]। এরপর HANDOFF.md-এর §৬ অনুযায়ী Batch 05 শুরু করো; ডেলিভারি-নিয়ম §২।"
