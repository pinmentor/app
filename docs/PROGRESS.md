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
