/**
 * Pulls a JSON value out of model text. Models often wrap JSON in ```json fences or add a sentence around it.
 * Returns { ok: false } instead of throwing; the caller validates the value with Zod afterwards.
 * No imports on purpose (unit-testable anywhere).
 */
export type JsonExtract = { ok: true; value: unknown } | { ok: false };

function tryParse(text: string): JsonExtract {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function extractJson(raw: string): JsonExtract {
  const text = raw.trim();
  if (text === "") return { ok: false };

  const direct = tryParse(text);
  if (direct.ok) return direct;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) {
    const inner = tryParse(fenced[1].trim());
    if (inner.ok) return inner;
  }

  // Last resort: the outermost {...} or [...] span.
  const firstObj = text.indexOf("{");
  const lastObj = text.lastIndexOf("}");
  if (firstObj !== -1 && lastObj > firstObj) {
    const span = tryParse(text.slice(firstObj, lastObj + 1));
    if (span.ok) return span;
  }
  const firstArr = text.indexOf("[");
  const lastArr = text.lastIndexOf("]");
  if (firstArr !== -1 && lastArr > firstArr) {
    const span = tryParse(text.slice(firstArr, lastArr + 1));
    if (span.ok) return span;
  }
  return { ok: false };
}
