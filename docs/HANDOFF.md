# PinMentor — হ্যান্ডঅফ (নতুন চ্যাটে কাজ চালিয়ে যাওয়ার জন্য)

> আপডেট: ২০২৬-১০-২২, Batch 14 শেষে। নতুন চ্যাটে এই ফাইল + সর্বশেষ রিপো-জিপ + `docs/PLAN.md` + `CLAUDE.md` + `sandbox-tools.zip` দাও।
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
| 04 | API কী অ্যাডমিন পেজ (`/admin/integrations`), `platform_secrets` (০০০৭) | মালিক নিশ্চিত: সব হয়েছে, টেস্ট পাস (১৭ অক্টোবর) |
| 05 | ম্যাপ-টেবিল (০০০৮), pgvector (০০০৯), `embed()`, S1→S4 জব-স্টেজ, `/admin/maps`, সুইপ + গোল্ড-লেবেলিং CLI | জিপ দেওয়া হয়েছে; ০০০৮/০০০৯ ও টেস্ট মালিকের চালানো বাকি; **স্টেজ-হ্যান্ডলার আসল DB/API-তে অচালিত** — PROGRESS.md দেখো |
| 06 | S5–S9: `silos`/`plan_items`/`map_snapshots` (০০১০), ইনটেন্ট/টাইপ, স্কোর, সাইলো, টাইটেল/স্লাগ/লিংক, ভেরিফিকেশন V1–V10, `/admin/maps/[id]` | জিপ দেওয়া হবে; ০০১০ ও `rls_0010.sql` (৩৭) মালিকের চালানো বাকি; S1→S9 শৃঙ্খল লোকাল Postgres-এ নকল LLM/ক্লায়েন্টে চলেছে, **আসল Supabase/LLM-এ অচালিত**। থ্রেশহোল্ড রি-টিউন ও গোল্ড-লেবেলিং করা হয়নি |
| 07 | Auto সাইজ (সীমা + আসল-দামে settle, `0011`), একাধিক-রাউন্ড কর্মী-লুপ (`jobs/tick-plan.ts`), `?gloss=` ভাষা-সুইচ, ডিবাগ-লগ পরিষ্কার | জিপ দেওয়া হয়েছে; আসল সময়/Auto-রানের ফল অপেক্ষমান |
| 08 | V2 নির্ভুল (জাজিং-ব্যান্ডের নিচের জোড়া ঝুঁকি নয়), স্টেজ-টাইমলাইন (`0012`), "Size and timing" ও "কেন এই আকার", V9-এ অন্বেষণ-বাকি সতর্কতা | জিপ দেওয়া হয়েছে; মালিকের ফল অপেক্ষমান |
| 09 | ইউজার-মুখী রিভিউ `/maps`, `/maps/[id]` (অনুমোদন/বাতিল, `0013`) | জিপ দেওয়া হয়েছে; `0013`/`rls_0013` (১৩) ও ব্রাউজার-যাচাই মালিকের বাকি |
| 10 | হাতে Merge / Split / Move (`0014`, `plan_links_fix`) | জিপ দেওয়া হয়েছে; `0014`/`rls_0014` (২০/২০) মালিক চালিয়েছেন; ব্রাউজারে Merge/Split/Move মালিক নিজে পরীক্ষা করেননি (ধরে নিয়েছেন ঠিক)। Batch 09 মালিক ব্রাউজারে পরীক্ষা করে ঠিক বলেছেন |
| 11 | স্ট্যাটাস-তালিকা PLAN §৪.১ (`draft`→`proposed`, `0015`), `batches` (`0016`), `/maps/[id]` তিন ট্যাব: Review / Dashboard / Batches | জিপ দেওয়া হয়েছে; `0015`/`0016`, `rls_0015` (১৩), `rls_0016` (২৬), আপডেট-করা `rls_0010/0013/0014` ও ব্রাউজার-যাচাই মালিকের বাকি; ক্রেডিট-দাম ও ব্যাচ-স্ট্যাটাসের নাম মালিকের সিদ্ধান্ত অপেক্ষমান |
| 12 | ক্রেডিট-দামের অ্যাডমিন `/admin/credits` + মাপা-খরচ রিপোর্ট (`0017`), আর্টিকেল-লেখা v1 Type A: `articles`, ব্যাচ-রান/hold/settle/cancel/watchdog (`0018`), `src/modules/articles/`, Batches-এ "Write this batch" | জিপ দেওয়া হয়েছে; `0017`/`0018`, `rls_0017` (১১), `rls_0018` (২৭) ও আসল রান মালিকের বাকি। **`article_write`-এর দাম বসানো নেই (মালিকের কাজ); আসল LLM-এ প্রম্পট চালানো হয়নি।** Batch 11 মালিক নিশ্চিত |
| 13 | স্প্যানিশ-অন্ধ রিভিউ (PLAN §৫.১): `article.review` (দ্বিতীয় মডেলের ভাষা-রিভিউ + ঝুঁকিপূর্ণ-দাবি), ট্রাফিক-লাইট, অনুরোধে ইংরেজি/বাংলা অনুবাদ-গ্লস (`0019`: `articles.review`, `article_gloss`, `article_gloss_request`, রুট `article_gloss`) | জিপ দেওয়া হয়েছে; `0019`/`rls_0019` (১৩) ও আসল রান মালিকের বাকি। **আসল LLM-এ রিভিউ/অনুবাদ প্রম্পট চালানো হয়নি।** Batch 12 মালিক নিশ্চিত |
| 14 | UI সরলীকরণ: "পরের ধাপ" কার্ড (Approve→Batch→Write→Check) সব ম্যাপ-পেজে, Batches কার্ড-ভিত্তিক, আর্টিকেল-পেজ তিন ট্যাব (Read/Checks/Translation), `/admin/credits`-এ একটাই দামের ঘর | জিপ দেওয়া হয়েছে; শুধু UI (SQL নেই); আসল ব্রাউজারে মালিকের পরিদর্শন বাকি। **মালিক GitHub CI এরর জানিয়েছেন; লগ চাওয়া হয়েছে, আগে ঠিক করতে হবে।** |

মালিকের বাকি করণীয় প্রতিটি ব্যাচের জন্য `docs/PROGRESS.md`-এর "মালিকের করণীয়" অংশে। **নতুন চ্যাটের প্রথম কাজ:** মালিককে জিজ্ঞেস করো Batch 06-এর আপলোড/CI সবুজ কি না, `0010` ও `rls_0010.sql` (৩৭/৩৭) ফল কী, এবং `/admin/maps`-এ ছোট রানের ফল (status, রিপোর্ট verdict ও V-সারি, লাল জব)। `rls_0008` ৬২/৬২ ও `pgvector_0009` ১৮/১৮ মালিক আগেই নিশ্চিত করেছেন। লাল হলে আগে ঠিক করো।

## ৪. রিপো-ম্যাপ (গুরুত্বপূর্ণ ফাইল)
- `supabase/migrations/0001…0007` — স্কিমা। `supabase/tests/` — SQL টেস্ট ও কনকারেন্সি স্ক্রিপ্ট; `supabase/tests/local/supabase_shim.sql` — লোকাল Postgres-এ Supabase-এর নকল (শুধু টেস্টের জন্য)। `supabase/ops/schedule_jobs.sql` — pg_cron শিডিউল (মালিক চালিয়েছেন)।
- `src/modules/llm/` — LLM-এর **একমাত্র দরজা** `callLlm()` (মডেল/দাম/রুট DB-তে; কিল-সুইচ, বাজেট-গার্ড; ফলব্যাক চেইন)। `src/modules/jobs/` — জব কিউ ক্লায়েন্ট; `/api/jobs/tick`।
- `src/modules/topical-map/stages.ts` (S1→S4 জব-হ্যান্ডলার + `map.advance` কোঅর্ডিনেটর), `stages-plan.ts` (S5→S9 হ্যান্ডলার), `stage-kit.ts` (সাধারণ সহায়ক), `classify.ts`/`score.ts`/`silo.ts`/`titles.ts`/`links.ts`/`verify.ts` (S5–S9-এর বিশুদ্ধ লজিক), `supabase/migrations/0010_topical_map_plan.sql`, `/admin/maps/[id]`, `plan.ts` (বিশুদ্ধ প্ল্যানিং/সিদ্ধান্ত), `stage-config.ts` (LIMITS, থ্রেশহোল্ড), `panel.ts` (গোল্ড-প্যানেল)। `src/modules/llm/embed.ts` = এমবেডিংয়ের একমাত্র দরজা।
- `src/modules/topical-map/` — S1/S2 প্রম্পট ও স্কিমা (`facets.ts`), S3 (`normalize.ts`, `lexicon.ts`), মডিফায়ার-ভেটো (`modifiers.ts`), `compare.ts`, `dedup.ts`, `judge.ts` (LLM ইনটেন্ট-জাজ, `callJson` ইনজেক্টেড), `serp.ts`, `embed.ts` (অফলাইন লেক্সিক্যাল বেসলাইন), `eval.ts`। ইভ্যাল: `eval/golden/es-peinados.jsonl`, `eval/floors.json`, `pnpm eval:dedup`।
- `src/lib/secrets/` — `providers.ts`, `crypto.ts` (AES-256-GCM, `ENCRYPTION_KEY`), `resolver.ts` (পিওর) / `resolve.ts` (DB-সংযুক্ত), `test-connection.ts`, `schemas.ts`।
- `src/lib/admin/` — `guard.ts` (`requireAdmin()`: role → 2FA aal2; অ-অ্যাডমিন 404), `roles.ts` (`canAdjustCredits`, `canManageJobs`, `canEnqueueTestJobs`, `canManageSecrets`, `canManageRates`), `credit-rates.ts` (/admin/credits-এর স্কিমা)।
- `src/app/admin/{users,jobs,integrations,mfa}`, `admin-nav.tsx` (`AdminShell`, `current="users|jobs|keys|maps|credits"`), `/admin/credits`। `src/components/brand.tsx`।
- ডিজাইন সিস্টেম: `src/app/globals.css` — টোকেন (লেগুন টিল `--brand`, পিন রোজ `--pin`, গাঁদা `--gold`), `pm-` ক্লাস, লাইট/ডার্ক অটো। নতুন UI-তে Tailwind ইউটিলিটি নয়, `pm-` ক্লাস; দরকারে `globals.css`-এর `@layer components`-এ যোগ করো।

## ৫. মূল প্রযুক্তিগত তথ্য
- **আর্টিকেল-লেখা:** `src/modules/articles/` — `prompts.ts` (প্রম্পট + Zod স্কিমা), `render.ts` (এস্কেপ-করা HTML), `qa.ts` (যান্ত্রিক QA), `progress.ts`, `review.ts` (ভাষা-রিভিউ প্রম্পট/স্কিমা, ট্রাফিক-লাইট), `gloss.ts` (অনুবাদ), `handlers.ts` (`article.outline|sections|assemble|review|gloss`, `jobs/handlers.ts`-এ নিবন্ধিত)। SQL (`0018`): `batch_run_start` hold করে, `article_finish` প্রতিটি শেষ হলে `batch_settle_if_done` ডাকে; দাম প্রতি `ready` আর্টিকেল; `PM005` = দাম নেই। `runner.ts` প্রতি tick-এ `article_watchdog` ডাকে।
- **ক্রেডিট লেজার:** append-only, held→committed|released, idempotency key, ওয়ার্কস্পেস-ভিত্তিক advisory lock। এরর: `PM001` insufficient_credits, `PM002` idempotency_conflict, `PM003` invalid_state, `PM004` not_found।
- **জব কিউ:** `FOR UPDATE SKIP LOCKED`, লিজ, watchdog, dead-letter, প্রোভাইডার-ভিত্তিক কনকারেন্সি; জবের সাথে ক্রেডিট-হোল্ড। pg_cron → pg_net → `/api/jobs/tick` (Bearer `CRON_SECRET`)।
- **অ্যাডমিন অ্যাকশন প্যাটার্ন:** `requireAdmin()` → রোল-চেক → Zod → `createAdminClient().rpc("admin_*", {p_admin, …, p_ip})` (SQL ফাংশন আবার রোল চেক করে ও `admin_audit` লেখে) → `revalidatePath` → `redirect(...?flash=code)`। ক্লায়েন্টকে কখনো ভেতরের এরর/সিক্রেট ফেরত নয়।
- **LLM টাস্ক-রুট (০০০৫-এ সিডেড):** `facet_generation`, `keyword_generation`, `intent_judge`, `map_audit`, `qa_cross_judge`, `title_generation`, `article_write`, `article_write_premium`, `research_outline`, `pin_copy`, `image_query`, `test_echo`। ক্রস-জাজ টাস্কে `avoidProvider` দিতে হয়।
- **ম্যাপ-রান:** `map_run_create` ক্রেডিট reserve করে, `map_run_finish` commit/release; স্টেজ-জবের নিজস্ব ক্রেডিট নেই; কোঅর্ডিনেটর পোল করে (ইভেন্ট-নির্ভর নয়); প্রতি tick-এ `map_run_watchdog`।
- **ডেডুপ ক্রম (`compare.ts`):** exact কী → মডিফায়ার-ভেটো (niñas≠niños, corto≠largo, 5≠10 minutos, con≠sin) → parent_child (সুপারসেট; কখনো অটো-মার্জ নয়) → একই কনটেন্ট → কোসাইন (`high 0.88`, `low 0.6` — **লেক্সিক্যাল এমবেডারের জন্য**) → বর্ডারলাইন জাজ। ভুল/অনুপস্থিত জাজ-উত্তর = আলাদা রাখা।
- **কী রিজলভার:** অ্যাডমিন-পেজের এনক্রিপ্টেড কী → না থাকলে env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DATAFORSEO_LOGIN/PASSWORD`)। ৬০ সেকেন্ড ক্যাশ।
- স্প্যানিশ লোকেল ডিফল্ট `es-MX` (মালিক আমার সিদ্ধান্তে ছেড়েছেন)। স্লাগে সাল নয়, আর্টিকেলে দাম/ডিসকাউন্ট নয় (CLAUDE.md)।

## ৬. পরের কাজ
**UI-নীতি (মালিকের স্থায়ী চাওয়া):** পেজে একটাই স্পষ্ট "পরের ধাপ" ও একটি প্রধান বোতাম; বাকি সব ভাঁজে (`<details class="pm-more">`)। নতুন ফিচারে আগে `next-step.ts`-এ ধাপ বসাও, পেজ ভারী কোরো না।
Batch 18 (WordPress publish/schedule + লাইভ লিংক: `0022`, `savePost`, `relatedHtml`; `rls_0021` এখন 0022-এর পরে ২৪/২৭ — প্রত্যাশিত; আসল WP-তে যাচাই বাকি, মালিকের ফল জিজ্ঞেস করো), Batch 17 (ড্যাশবোর্ড রিডিজাইন: `src/lib/home/*`, `components/path.tsx`; UI-নীতি অনুযায়ী ধাপ-রেখা) হয়েছে; Batch 16 (WordPress — মালিক নিশ্চিত করেছেন আসল সাইটে কাজ করেছে: `0021`, `src/modules/wordpress/`, `/sites`, আর্টিকেল-পেজের বোতাম; আসল WP-তে যাচাই হয়নি — মালিকের ফল জিজ্ঞেস করো), Batch 14 (UI) ও Batch 15 (পাবলিশ-ডেটা: `0020`, `publish.ts`; লিংক HTML-এ নেই, পাবলিশার বসাবে) হয়েছে; Batch 15-এর ফল ও CI-লগ মালিককে জিজ্ঞেস করো। Batch 13 হয়েছে। **মালিককে প্রথমে জিজ্ঞেস করো:** `0019` ও `rls_0019` (১৩/১৩) চালিয়েছেন কি না; পুরনো আর্টিকেলে বাংলা/ইংরেজি অনুবাদ কাজ করল কি না ও অর্থ-বিচার চলে কি না; নতুন আর্টিকেলে ট্রাফিক-লাইট, `language_review` ও `risky_claims` কেমন (রিভিউ কি বেশি কড়া/ঢিলা?), "SAME company" লেখা এল কি না (শুধু এক কোম্পানির কী থাকলে), `/admin/credits`-এ `qa_cross_judge`/`article_gloss` খরচ, `/admin/jobs`-এ লাল `article.*` জব। লাল হলে আগে ঠিক করো (প্রম্পট/স্কিমা আসল আউটপুট না দেখে অনুমান)।
**স্থায়ী নিয়ম:** `article_write`-এর ক্রেডিট-দাম মালিক `/admin/credits` থেকে ঠিক করবেন; আমি কোনো দাম বসাই না, মালিককে না জিজ্ঞেস করে ক্রেডিট-দাম বা স্ট্যাটাস-নাম বদলাই না। দাম না থাকলে রান `PM005` দিয়ে আটকায়। **টেস্টে কখনো সময় (`now()`/`created_at`) দেখে "সর্বশেষ সারি" বাছা নয়** (Supabase SQL Editor ফাইল এক ট্রানজেকশনে চালায়); নতুন `rls_*` ফাইল এক-ট্রানজেকশনেও (`psql -c "$(cat file)"`) চালাও।
চালু অবস্থা: S1→S9; Review/Dashboard/Batches; ব্যাচ → "Write this batch" (hold) → `article.outline` → `article.sections` → `article.assemble` → `article.review` (`ready`; এখানে settle) ; আর্টিকেল-পেজ `/maps/[id]/articles/[articleId]`: ট্রাফিক-লাইট, QA, ভাষা-রিভিউ, অনুবাদ-গ্লস, প্রিভিউ। ড্রাফট/পাবলিশ/শিডিউল আছে; Pinterest এখনো নেই (পরের ব্যাচ: Pinterest পিন বা ইমেজ; ইউআই-পরিমার্জন মালিক পরে চেয়েছেন — `articles.links` থেকে শুধু লাইভ লিংক বসানো, `schema_json` ইনজেক্ট)।
**পরের সম্ভাব্য কাজ (মালিকের ফল দেখে):** প্রম্পট/QA/সীমা টিউন; গবেষণা/তথ্য-ভিত্তি (PLAN §৫); ইমেজ + WordPress পাবলিশ (লালে বন্ধ); ব্যাক-ট্রান্সলেশন; ক্রেডিট-এস্টিমেট (দাম ঠিক হলে); ব্যর্থ আর্টিকেলের retry; আর্টিকেল সম্পাদনা; Type B।

## ৭. খোলা ঋণ ও সতর্কতা
- **লকফাইল ঋণ:** `pnpm-lock.yaml` পুরনো (এই স্যান্ডবক্সে npm বন্ধ ছিল)। সাময়িক: `.npmrc` (`frozen-lockfile=false`) ও CI-তে `--no-frozen-lockfile`। কোনো কম্পিউটারে `pnpm install` চালিয়ে নতুন লকফাইল কমিট, তারপর `.npmrc` মুছে `--frozen-lockfile` ফেরানো। নতুন devDependency `tsx` (Batch 03) ওই লকফাইলেই যাবে।
- `@supabase/ssr` 0.6.1-এ পিন; shadcn/ui ও Playwright স্মোক টেস্ট এখনো যোগ হয়নি।
- গোল্ড-সেট `provisional` (এক লেবেলার, আমি; প্ল্যান ৩.১০-এর প্রোটোকল চলেনি)। test স্প্লিট পুরোপুরি অদেখা নয়। একজন স্প্যানিশ-জানা মানুষকে দিয়ে দেখানো সুপারিশকৃত।
- DataForSEO অ্যাডাপ্টার ও চার প্রোভাইডারের "Test connection" এন্ডপয়েন্ট লাইভ যাচাই হয়নি।
- ম্যাজিক-লিংকের "We could not send the link" (সম্ভবত Supabase বিল্ট-ইন ইমেইল রেট-লিমিট) — মালিক পরে আর উল্লেখ করেননি; নিশ্চিত নয়। দরকারে নিজস্ব SMTP সেটআপ প্রস্তাব করো।
- pgvector এই স্যান্ডবক্সে নেই: ০০০৯-এর যুক্তি real[]-স্টাব দিয়ে চালানো যায় (স্টাব রেসিপি PROGRESS-এর যাচাই-অংশে); আসল যাচাই মালিকের Supabase-এ।
- (পুরনো) `/home/claude/work/src/modules/topical-map/vector.ts` নামে একটি অজানা ফাইল আগের সেশনের ওয়ার্কস্পেসে ছিল (আমার লেখা নয়, `embed.ts`-এর সাথে মেলে না, টাইপচেক ভাঙে); জিপে দেওয়া হয়নি। রিপোতে এটা থাকলে মালিককে জিজ্ঞেস করে মুছতে বলো।
- মালিকের Supabase/Vercel সেটআপের তথ্য: রিপো `github.com/pinmentor/app`, ব্রাঞ্চ `main`; Vercel এনভ: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TURNSTILE_SITE_KEY`, `CRON_SECRET`, ও Batch 04 থেকে `ENCRYPTION_KEY`।

## ৮. স্যান্ডবক্সে যাচাইয়ের পদ্ধতি (প্রতি নতুন সেশনে বদলাতে পারে; `sandbox-tools.zip` দেখো)
- **npm/pnpm ইনস্টল ব্লক (৪০৩)** — ঘুরিয়ে চেষ্টা কোরো না। তাই `pnpm lint/typecheck/test/build` চালানো যায় না; মালিককে বলো CI/Vercel-ই প্রথম পরীক্ষা।
- **SQL:** লোকাল Postgres 16 (`pg_ctlcluster 16 main start`; `su postgres -c "psql …"`)। `postgres` ইউজার স্ক্র্যাচপ্যাড পড়তে পারে না, তাই ফাইল কপি করো `/tmp/pgrun`-এ (chmod 755/644)। ডাটাবেস বানাও, `supabase/tests/local/supabase_shim.sql` চালাও, তারপর `000N` মাইগ্রেশন ক্রমে, তারপর টেস্ট। রিপোর `supabase/migrations` ফোল্ডারে বাইরের কোনো ফাইল ঢুকিও না (আগে একটি অতিরিক্ত ফাইল ভুয়া ফেল দিয়েছিল)।
- **TypeScript:** `tsx` গ্লোবাল (`/home/claude/.npm-global/bin`), `zod` **v3.25** `/opt/npm-tools/node_modules`-এ (প্রজেক্টের zod 4-এর `z.uuid()`, `z.url()` এখানে নেই)। টেস্টের জন্য ছোট vitest-সদৃশ শিম (`describe/it/expect` সাবসেট) + `NODE_PATH`। টাইপচেক: গ্লোবাল `tsc` + stub ডিক্লারেশন (next, react, supabase)। প্রিটিয়ার সিনট্যাক্স-পার্সের জন্য।
- **UI প্রিভিউ:** স্ট্যাটিক HTML + `globals.css` (Google Fonts লোড হয় না; Inter দিয়ে প্রতিস্থাপিত) + Playwright/Chromium স্ক্রিনশট (লাইট/ডার্ক, ডেস্কটপ/মোবাইল)।
- ইন্টারনেট: শুধু অনুমোদিত তালিকা (প্যাকেজ রেজিস্ট্রি/GitHub); অন্য সাইটে curl ব্লক।

## ৯. নতুন চ্যাটের শুরুর মেসেজের খসড়া
"এটা PinMentor প্রজেক্ট। সংযুক্ত রিপো-জিপ, `CLAUDE.md`, `docs/PROGRESS.md`, `docs/PLAN.md`, `docs/HANDOFF.md` ও `sandbox-tools.zip` আছে। আগে ওগুলো পড়ো। Batch 03/04 আপলোড ও যাচাইয়ের ফল: [এখানে লিখুন]। এরপর HANDOFF.md-এর §৬ অনুযায়ী Batch 05 শুরু করো; ডেলিভারি-নিয়ম §২।"
