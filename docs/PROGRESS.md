# PROGRESS

> প্রতিটি ব্যাচ শেষে এজেন্ট এটা আপডেট করে। নতুন সেশনে `CLAUDE.md`-এর পরেই এটা পড়তে হবে।

## সম্পন্ন ব্যাচ
- **01A (টাস্ক 0.1, 0.7, 0.8 আংশিক):** Next.js 16 (App Router, TS strict) + Tailwind 4 + ESLint + Vitest; `src/lib/slugify.ts` (৩৩ টেস্ট, সাল-স্ট্রিপ), `src/lib/languages.ts`; GitHub Actions CI (lint/typecheck/test/build)। লোকালি চারটা কমান্ড সবুজ। সিদ্ধান্ত: TypeScript 5-এ পিন (TS 7 টাইপস্ক্রিপ্ট-eslint-এর সাথে চলে না); shadcn/ui ও Playwright স্মোক UI-ওয়ালা ব্যাচে (01B) যোগ হবে; `languages` DB সিড 01B-র মাইগ্রেশনে।

## চলমান ব্যাচ
Batch 01B — টাস্ক 0.2, 0.3 (Supabase স্কিমা + RLS, Auth, Turnstile, workspace অটো-তৈরি): শুরু হয়নি

## পরের ব্যাচ
Batch 01C — টাস্ক 0.4–0.6 (ক্রেডিট লেজার, events/audit, অ্যাডমিন + 2FA)
তারপর Batch 02 — Phase 1 (LLM রাউটার, জব কিউ)

## খোলা সিদ্ধান্ত / ব্লকার
- ফেজ 2a-র আগে: SERP প্রোভাইডার ডিপোজিট (PLAN §৩.৭) — Bilal-এর সম্মতি অপেক্ষমান
