import { prisma } from "./db";

// Ensure one auto-RETA expense exists per month from the start of `year` up to
// (and including) the current month. Idempotent: identified by `retaYearMonth`.
// If the user changes the configured cuota, prior auto-rows are left alone and
// only future months get the new amount — this matches reality (RETA can change
// month to month based on declared base).
//
// Used by the one-shot historical migration to backfill prior years. The live
// app no longer calls this — month-by-month creation is driven by the cron
// in scripts/bot-poll.ts, which uses `ensureRetaExpenseForMonth` below.
export async function ensureRetaExpensesForYear(year: number): Promise<{ created: number }> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings || settings.retaMonthlyCuotaCents <= 0) return { created: 0 };

  const now = new Date();
  const lastMonthIndex = year < now.getUTCFullYear() ? 11 : now.getUTCMonth();
  let created = 0;

  for (let m = 0; m <= lastMonthIndex; m++) {
    const didCreate = await createRetaExpenseIfMissing(year, m, settings.retaMonthlyCuotaCents);
    if (didCreate) created++;
  }
  return { created };
}

// Create the RETA expense for a single month if one doesn't already exist.
// Returns true when a row was created. Idempotent via the `retaYearMonth`
// unique constraint.
export async function ensureRetaExpenseForMonth(
  year: number,
  monthIndex: number,
): Promise<{ created: boolean }> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings || settings.retaMonthlyCuotaCents <= 0) return { created: false };
  const created = await createRetaExpenseIfMissing(year, monthIndex, settings.retaMonthlyCuotaCents);
  return { created };
}

async function createRetaExpenseIfMissing(
  year: number,
  monthIndex: number,
  cuotaCents: number,
): Promise<boolean> {
  const tag = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
  const existing = await prisma.expense.findUnique({ where: { retaYearMonth: tag } });
  if (existing) return false;

  // Use the last day of the month so it falls inside that quarter unambiguously.
  const date = new Date(Date.UTC(year, monthIndex + 1, 0));
  await prisma.expense.create({
    data: {
      date,
      vendor: "Tesorería General de la Seguridad Social",
      category: "SOCIAL_SECURITY",
      grossCents: cuotaCents,
      netCents: cuotaCents,
      vatRate: 0,
      vatCents: 0,
      deductiblePct: 100,
      deductibleNetCents: cuotaCents,
      deductibleVatCents: 0,
      status: "CONFIRMED",
      source: "AUTO_RETA",
      retaYearMonth: tag,
      notes: "Auto-generated RETA cuota (100% IRPF-deductible).",
    },
  });
  return true;
}
