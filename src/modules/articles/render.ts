import type { Locale } from "@/modules/topical-map/lexicon";
import type { ConclusionContent, FaqContent, IntroContent, ItemContent } from "./prompts";

/** The article page as HTML. Every piece of text is escaped here: model output never becomes markup. */

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const LABELS = {
  es: { highlights: "Lo más destacado", faq: "Preguntas frecuentes", conclusion: "Conclusión" },
  en: { highlights: "Key takeaways", faq: "Frequently asked questions", conclusion: "Conclusion" },
} as const;
export const labelsFor = (locale: Locale) => (locale.startsWith("es") ? LABELS.es : LABELS.en);

export type ArticleParts = {
  title: string;
  locale: Locale;
  highlights: string[];
  intro: IntroContent;
  items: ItemContent[];
  faq: FaqContent;
  conclusion: ConclusionContent;
};

const p = (xs: string[]) => xs.map((x) => `<p>${escapeHtml(x)}</p>`).join("\n");

export function renderArticle(a: ArticleParts): string {
  const l = labelsFor(a.locale);
  const out: string[] = [];
  out.push(`<h1>${escapeHtml(a.title)}</h1>`);
  if (a.highlights.length) out.push(`<h2>${l.highlights}</h2>\n<ul>\n${a.highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join("\n")}\n</ul>`);
  out.push(p(a.intro.paragraphs));
  a.items.forEach((it, k) => {
    const bullets = it.bullets.length ? `\n<ul>\n${it.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("\n")}\n</ul>` : "";
    out.push(`<h2>${k + 1}. ${escapeHtml(it.heading)}</h2>\n${p(it.paragraphs)}${bullets}`);
  });
  if (a.faq.items.length) out.push(`<h2>${l.faq}</h2>\n${a.faq.items.map((q) => `<h3>${escapeHtml(q.question)}</h3>\n<p>${escapeHtml(q.answer)}</p>`).join("\n")}`);
  out.push(`<h2>${l.conclusion}</h2>\n${p(a.conclusion.paragraphs)}`);
  return out.join("\n\n");
}

/** All visible text of the article (for word count and QA). */
export function plainText(a: ArticleParts): string {
  return [a.title, ...a.highlights, ...a.intro.paragraphs, ...a.items.flatMap((i) => [i.heading, ...i.paragraphs, ...i.bullets]), ...a.faq.items.flatMap((q) => [q.question, q.answer]), ...a.conclusion.paragraphs].join("\n");
}

export const countWords = (s: string) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
