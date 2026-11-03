# PROGRESS — প্রতি ব্যাচে ≤ ২০ লাইন (B01–B21-এর পুরনো লগ: `docs/archive/PROGRESS_B01-B21.md`; নতুন চ্যাটের কিটে আর্কাইভ লাগে না)
ক্রম ও সিদ্ধান্ত: `MASTER_PLAN.md`। ইঞ্জিন-স্পেক: `docs/PLAN.md`।

## B22 — যাচাই-গেট (২০২৬-১১-০১) · অবস্থা: ডেপ্লয় সফল (মালিক, ০২ নভেম্বর); আসল-যাচাই তালিকা নিশ্চিত নয়
**কী বদলাল**
- `PROGRESS.md` আর্কাইভে সরল (১৬৯KB → এই ফাইল); `HANDOFF.md` বাতিল (মাস্টার প্ল্যানই হ্যান্ডঅফ)।
- `CLAUDE.md`: shadcn/ui লাইন বাদ (আসল সিস্টেম `globals.css`-এর `pm-`); "মালিক CLI চালান না" ও কাজের-ক্রমের লাইন যোগ।
- `.env.example`: Resend/SMTP-র জায়গা (অ্যাপ এটা পড়ে না; Supabase → Auth → SMTP-তে বসে)।
- `.github/workflows/lockfile.yml` (নতুন, হাতে বসাতে হবে) ও `ci.yml`-এর `--frozen-lockfile` সংস্করণ — **ধাপ ২, লকফাইল কমিটের পর**।
**কীভাবে টেস্ট:** কোড-টেস্ট চালানো যায়নি — এই সেশনে npm রেজিস্ট্রি নীতি-অনুযায়ী বন্ধ (403)। কোড (`src/`) এই ব্যাচে বদলায়নি।
**পর্যবেক্ষণ (স্ট্যাটিক):**
- `invalid_output|<head>` ডিবাগ-টুকরো কোডে **নেই** (`llm/client.ts` এখন শুধু `invalid_output:<why>` কারণ-কোড লেখে); পুরনো লগের "ডিবাগ থেকে যায়" মন্তব্য বাসি। আসল রানে শূন্য `invalid_output` কি না — **অযাচাইকৃত**।
- tick: প্রতি মিনিটে ১ কল = ~৪৩,২০০/মাস (৩০ দিন)। Vercel Hobby-র অন্তর্ভুক্ত ফাংশন-ইনভোকেশন ১,০০০,০০০ (২০২৬-০৯-১৪-র ডকে) → ~৪.৩%। Active CPU ৪ ঘণ্টা/মাস: idle tick মিলিসেকেন্ডের, কাজের tick বেশিরভাগ LLM-অপেক্ষা (I/O) — **আসল Active-CPU ব্যবহার Vercel ড্যাশবোর্ডে মালিকের দেখা বাকি**। ফাঁক বাড়ানোর দরকার নেই।
- `src/app`-এ কোনো `loading.tsx`/`error.tsx`/`not-found.tsx` নেই → B23-এ।
**কী অযাচাইকৃত:** CI "CL" এরর (লগ পাইনি); লকফাইল (ওয়ার্কফ্লো চালানো হয়নি); Resend ইমেইল; মালিকের আসল-যাচাই তালিকা (সবটা); DataForSEO/Test-connection; গোল্ড-সেট।

## B23a — সিঁড়ি, নেভ, Library, Queue (২০২৬-১১-০২) · অবস্থা: কোড লেখা, **চালানো/বিল্ড হয়নি**
**কী বদলাল**
- `lib/home/stepper.ts` (+ টেস্ট): ৮ ধাপ; Pictures/Pins/Schedule "Coming soon", বাকি লক-ধাপে "Opens after X"। `stepper-data.ts` RLS-এর ওপর count পড়ে; ব্যর্থ হলে সিঁড়ি লুকায়।
- `AppFrame` (async): লোগো/ইমেইল/Sign out + নেভ (Home·Websites·Maps·Articles·Queue + Soon: Pins·Schedule·Results·Settings) + সিঁড়ি। Dashboard এখন `AppFrame` ব্যবহার করে।
- নতুন: `/articles` (স্ট্যাটাস/চেক/WP ফিল্টার), `/queue` (আর্টিকেল ও ম্যাপ থেকে; `jobs` অ্যাডমিন-অনলি থাকে), `loading/error/not-found`, CSS `pm-ladder*`, `pm-nav*`, `pm-chips`, `pm-list`।
**কীভাবে টেস্ট:** শুধু `stepper.ts` নোড দিয়ে হাতে চালিয়ে ৪টি অবস্থা মিলিয়েছি। `pnpm lint/typecheck/test/build` চলেনি (npm বন্ধ)।
**কী অযাচাইকৃত:** টাইপ/লিন্ট/বিল্ড; `qa->>verdict` ফিল্টার আসল DB-তে; `AppFrame` async হওয়ায় প্রতি পেজে ৫টি অতিরিক্ত কুয়েরি (ধীর লাগলে জানাও); মোবাইলে সিঁড়ির চেহারা; B23b বাকি (MASTER_PLAN)।

## B23b — Websites ভাষা/CTA, Settings (২০২৬-১১-০২) · অবস্থা: কোড+SQL লেখা, লোকালে SQL-টেস্ট সবুজ, **অ্যাপ বিল্ড হয়নি**
**কী বদলাল**
- `0026_site_settings_review_language.sql`: `sites.language/locale/cta_label` (ডিফল্ট es/es-MX/খালি, locale ভাষার সাথে মিলতে হয়), `workspaces.review_language` (ডিফল্ট bn); ফাংশন `site_update_settings`, `workspace_set_review_language` (শুধু service_role; দ্বিতীয়টা শুধু owner/admin)।
- `/sites` = "Websites": প্রতি সাইটে ভাষা (locale ভাষা থেকে নিজে বসে) ও CTA ফর্ম। নতুন `/settings` (অ্যাকাউন্ট + ডিফল্ট অনুবাদ ভাষা); নেভে Settings চালু। আর্টিকেল-অনুবাদ ট্যাব `?lang=` না থাকলে ওয়ার্কস্পেসের ডিফল্ট নেয়।
**কীভাবে টেস্ট:** `rls_0026.sql` লোকাল Postgres 16 + শিমে (pgvector ছাড়া, ০০০৯ বাদ) ২৭/২৭ পাস। অ্যাপ-কোডে lint/typecheck/build চলেনি (npm বন্ধ)।
**কী অযাচাইকৃত:** আসল Supabase-এ 0026 ও `rls_0026`; ফর্মগুলো ব্রাউজারে; `<select>`-এর `pm-input` চেহারা; CTA-লেবেল এখনো কোনো আর্টিকেলে বসে না (B28/B30)।

## B23c — Dashboard সরলীকরণ, Queue (২০২৬-১১-০৩) · অবস্থা: কোড লেখা, বিল্ড হয়নি
- `/dashboard`: ৮-ধাপের সিঁড়ির নিচে শুধু বর্তমান ধাপের কার্ড ও তার একটাই বোতাম (`PathList` নতুন `startAt`)।
- `/queue`: ব্যর্থ আর্টিকেলের পাশে "লিখতে ফ্রি, শুধু ready-তে খরচ" ও ব্যাচ-পেজের লিংক। আলাদা Retry বানাইনি: ব্যর্থ আইটেম নিজেই `approved`-এ ফেরে; এক-ক্লিক রিট্রাই কনফার্ম ছাড়া ক্রেডিট খরচ করত। SQL/RLS বদল নেই।
- যাচাই-পর্বে জমা: Playwright, আসল-যাচাই তালিকা (MASTER_PLAN §২.২)।

## B24a — কিওয়ার্ড লাইব্রেরি ও নিজের-কিওয়ার্ড ম্যাপ (২০২৬-১১-০৩) · অবস্থা: কোড+SQL লেখা; SQL ও পার্সার লোকালে সবুজ; **অ্যাপ বিল্ড/আসল রান হয়নি**
**কী বদলাল**
- `0027_keyword_library.sql`: `keyword_library` (RLS, শুধু পড়া), `keywords_import` (≤২০০০/কল, ওয়ার্কস্পেসে ≤৫০০০, norm_key-এ ডেডুপ), `keywords_delete`, `map_run_create_own` ("Expand + mine": সাধারণ রান + `manual` প্রার্থী; "Only my keywords": ≥১০, S1 জব বাতিল, রান S3 থেকে শুরু), `admin_map_run_create_own` (সুপারঅ্যাডমিন, নিজের ওয়ার্কস্পেস, `admin_audit`)। ক্রেডিট = বিদ্যমান `map_credit_cost`।
- `/keywords`: পেস্ট বা CSV/TXT আপলোড (≤৫১২KB), ভাষা, ট্যাগ; রিপোর্ট (যোগ/আগেই ছিল/বাদ + লাইন-নম্বরসহ কারণ); সার্চ; ঝাড়াই। নেভে Keywords।
- `modules/keywords/csv.ts`: হেডার-সচেতন CSV, একক-লাইন কমা-তালিকা, ম্যাপের নিজস্ব normaliser দিয়ে ডেডুপ, খারাপ সারি কারণসহ ফেরত।
- `/admin/maps` ফর্মে "My own keywords": টেক্সট, লাইব্রেরি যোগ, "only mine"।
**কীভাবে টেস্ট:** `rls_0027.sql` লোকাল Postgres 16 + শিমে ৪১/৪১; CSV-পার্সারের ১০ টেস্ট নোডে হাতে-চালানো হারনেসে (vitest নয়)। lint/typecheck/build চলেনি।
**কী অযাচাইকৃত:** আসল Supabase-এ 0027; অ্যাপ বিল্ড; "Only my keywords" রানে S3→S9 আসল API-তে; ফাইল-আপলোড ফর্ম (`multipart`) ব্রাউজারে।
