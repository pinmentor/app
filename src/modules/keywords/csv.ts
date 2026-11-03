import { fold, normalize } from "../topical-map/normalize";
import type { Locale } from "../topical-map/lexicon";

/**
 * Reads the keywords a user pastes or uploads (a plain list, or a CSV with a header). Pure, so every rule is testable.
 *  - one keyword per line; a lone line with commas ("a, b, c") is split on the commas;
 *  - a CSV is recognised by a header with a keyword column (keyword, keywords, query, term, text, kw, palabra clave ...);
 *    an optional tags column (tags, tag, labels, category, etiquetas) is split on | ; ,
 *  - the same keyword in other spellings ("Peinados fáciles" / "peinados faciles") collapses to the first one, using the map's own normaliser;
 *  - bad rows are never silently dropped: they come back with their line number and a reason.
 */
export const MAX_ITEMS = 2000;
export const MAX_BYTES = 512 * 1024;
export const MAX_WORDS = 12;

export type ParsedKeyword = { text: string; normKey: string; tags: string[] };
export type RejectReason = "too_long" | "too_many_words" | "no_letters" | "looks_like_url" | "only_filler_words";
export type Rejected = { line: number; text: string; reason: RejectReason };
export type ParseResult = { items: ParsedKeyword[]; rejected: Rejected[]; duplicatesInFile: number; truncated: boolean; hadHeader: boolean };

export const REJECT_TEXT: Record<RejectReason, string> = {
  too_long: "longer than 200 characters",
  too_many_words: `more than ${MAX_WORDS} words (looks like a sentence)`,
  no_letters: "has no letters or digits",
  looks_like_url: "looks like a web address",
  only_filler_words: "only filler words, nothing to search for",
};

const KEYWORD_HEADERS = new Set(["keyword", "keywords", "query", "queries", "term", "terms", "text", "kw", "palabra clave", "palabras clave", "consulta", "consultas", "top queries"]);
const TAG_HEADERS = new Set(["tags", "tag", "label", "labels", "category", "categories", "etiquetas", "etiqueta"]);

/** One CSV line into cells; "double quotes" may hold the delimiter, "" is a quote. */
export function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

const delimiterOf = (line: string) => (line.includes("\t") ? "\t" : line.includes(";") ? ";" : ",");
const squeeze = (s: string) => s.replace(/\s+/g, " ").trim();
const cleanTags = (raw: string | undefined): string[] =>
  raw ? [...new Set(raw.split(/[|;,]/).map((t) => squeeze(t).slice(0, 40)).filter(Boolean))].slice(0, 10) : [];

export function parseKeywordInput(input: string, locale: Locale): ParseResult {
  const lines = input.replace(/^﻿/, "").split(/\r?\n/);
  const result: ParseResult = { items: [], rejected: [], duplicatesInFile: 0, truncated: false, hadHeader: false };
  const seen = new Set<string>();

  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  if (firstIdx === -1) return result;

  // header?
  const delim = delimiterOf(lines[firstIdx]!);
  const headerCells = splitCsvLine(lines[firstIdx]!, delim).map((c) => squeeze(c).toLowerCase());
  const kwCol = headerCells.findIndex((c) => KEYWORD_HEADERS.has(c));
  const tagCol = headerCells.findIndex((c) => TAG_HEADERS.has(c));
  result.hadHeader = kwCol !== -1;

  // a lone line with commas is a pasted list
  const nonEmpty = lines.filter((l) => l.trim() !== "");
  const loneList = !result.hadHeader && nonEmpty.length === 1 && nonEmpty[0]!.includes(",");

  const add = (lineNo: number, rawText: string, tags: string[]) => {
    if (result.items.length >= MAX_ITEMS) {
      result.truncated = true;
      return;
    }
    const text = squeeze(rawText.replace(/^["']+|["']+$/g, ""));
    if (text === "") return; // blank cell: nothing to report
    const reject = (reason: RejectReason) => result.rejected.push({ line: lineNo, text: text.slice(0, 80), reason });
    if (text.length > 200) return reject("too_long");
    if (/^https?:\/\//i.test(text) || /^www\./i.test(text)) return reject("looks_like_url");
    if (!/[\p{L}\p{N}]/u.test(text)) return reject("no_letters");
    if (text.split(" ").length > MAX_WORDS) return reject("too_many_words");
    const key = normalize(text, locale).key;
    if (key === "") return reject("only_filler_words");
    if (seen.has(key)) {
      result.duplicatesInFile++;
      return;
    }
    seen.add(key);
    result.items.push({ text, normKey: key.slice(0, 200), tags });
  };

  for (let i = result.hadHeader ? firstIdx + 1 : firstIdx; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const lineNo = i + 1;
    if (result.hadHeader) {
      const cells = splitCsvLine(line, delim);
      add(lineNo, cells[kwCol] ?? "", tagCol === -1 ? [] : cleanTags(cells[tagCol]));
    } else if (loneList) {
      for (const part of line.split(",")) add(lineNo, part, []);
    } else {
      // plain list; a tab or semicolon means a spreadsheet row: the first cell is the keyword
      const cell = line.includes("\t") ? line.split("\t")[0]! : line.includes(";") ? line.split(";")[0]! : line;
      add(lineNo, cell, []);
    }
    if (result.truncated) break;
  }
  return result;
}

/** Same folding the map uses for matching, exported for the pages that need a stable key of free text. */
export const foldKey = fold;
