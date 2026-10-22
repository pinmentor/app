-- 0020_article_publish_data.sql — Batch 15: what an article needs besides its text before it can be published. Requires 0018.
--
--   * meta_description : the search-result description (written together with the outline, no extra AI call; falls back to the intro)
--   * schema_json      : schema.org JSON-LD (Article, ItemList, FAQPage) built by code from the finished article
--   * links            : planned internal links [{plan_item_id, role: pillar|sibling|child, title, slug}] from the map's link plan.
--                        NOT written into body_html on purpose: the publisher inserts only links to articles that are really
--                        published (a link to a page that does not exist yet is worse than no link).
-- No new function: the assemble job writes these columns with the service role (like body_html), article_finish is unchanged.

alter table public.articles
  add column meta_description text check (meta_description is null or char_length(meta_description) <= 400),
  add column schema_json      jsonb,
  add column links            jsonb not null default '[]'::jsonb;
