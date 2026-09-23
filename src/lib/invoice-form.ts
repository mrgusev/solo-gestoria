// Parsing helpers shared by the create + edit invoice server actions. The
// browser sends the line rows as one JSON blob (the row count is dynamic), so
// everything gets validated here before it reaches the DB.

import { z } from "zod";
import type { InvoiceLineInput } from "./invoice";
import { pctToRate } from "./invoice-totals";

const lineSchema = z.object({
  description: z.string().trim().min(1, "Every line needs a description"),
  quantity: z.number().positive("Quantity must be > 0"),
  unit: z.string().trim().max(10).default("h"),
  unitPriceCents: z.number().int().min(0),
  vatRate: z.number().min(0).max(1),
});

const linesSchema = z.array(lineSchema).min(1, "An invoice needs at least one line");

export function parseInvoiceFormLines(raw: FormDataEntryValue | null): InvoiceLineInput[] {
  if (raw == null) throw new Error("Missing invoice lines");
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new Error("Invoice lines were not valid JSON");
  }
  const result = linesSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(result.error.issues.map((i) => i.message).join("; "));
  }
  return result.data;
}

export function parseInvoiceFormDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Noon UTC, matching the rest of the app — keeps the date stable across TZs.
  return new Date(Date.UTC(y, mo - 1, d, 12));
}

// Percent field → fraction. Absent (the input is hidden for exempt clients)
// means no retention.
export function parseRatePct(raw: FormDataEntryValue | null): number {
  if (raw == null || String(raw).trim() === "") return 0;
  const pct = Number(raw);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new Error("Rate must be a percentage between 0 and 100");
  }
  return pctToRate(pct);
}
