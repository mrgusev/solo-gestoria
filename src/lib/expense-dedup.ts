import { prisma } from "./db";
import type { Expense } from "@prisma/client";

// Look for an existing expense that matches a freshly-parsed receipt. Match
// criteria: same UTC calendar day + same gross amount + one of
//   (a) same vendor VAT id (both non-null, case-insensitive), or
//   (b) same normalized vendor name (lower-case, collapsed whitespace).
//
// (b) is the fallback because many receipts (Wise/Revolut transfers, supermercado
// tickets) have no VAT id on the document but still re-upload identically.
export async function findDuplicateExpense(input: {
  date: Date;
  vendor: string;
  vendorVatId: string | null;
  grossCents: number;
}): Promise<Expense | null> {
  const dayStart = new Date(Date.UTC(
    input.date.getUTCFullYear(),
    input.date.getUTCMonth(),
    input.date.getUTCDate(),
    0, 0, 0, 0,
  ));
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const candidates = await prisma.expense.findMany({
    where: {
      grossCents: input.grossCents,
      date: { gte: dayStart, lt: dayEnd },
    },
  });
  if (candidates.length === 0) return null;

  const normVat = normalizeVat(input.vendorVatId);
  const normVendor = normalizeVendor(input.vendor);

  for (const c of candidates) {
    if (normVat && normalizeVat(c.vendorVatId) === normVat) return c;
    if (normalizeVendor(c.vendor) === normVendor) return c;
  }
  return null;
}

function normalizeVat(v: string | null): string | null {
  if (!v) return null;
  const trimmed = v.trim().toUpperCase().replace(/\s+/g, "");
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeVendor(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, " ");
}
