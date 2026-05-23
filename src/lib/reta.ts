import { prisma } from "./db";

// Ensure one auto-RETA expense exists per month from the start of `year` up to
// (and including) the current month. Idempotent: identified by `retaYearMonth`.
// If the user changes the configured cuota, prior auto-rows are left alone and
// only future months get the new amount — this matches reality (RETA can change
// month to month based on declared base).
export async function ensureRetaExpensesForYear(year: number): Promise<{ created: number }> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings || settings.retaMonthlyCuotaCents <= 0) return { created: 0 };

  const now = new Date();
  const lastMonthIndex = year < now.getUTCFullYear() ? 11 : now.getUTCMonth();
  let created = 0;

  for (let m = 0; m <= lastMonthIndex; m++) {
    const tag = `${year}-${String(m + 1).padStart(2, "0")}`;
    const existing = await prisma.expense.findUnique({
      where: { retaYearMonth: tag },
    });
    if (existing) continue;

    // Use the last day of the month so it falls inside that quarter unambiguously.
    const date = new Date(Date.UTC(year, m + 1, 0));
    await prisma.expense.create({
      data: {
        date,
        vendor: "Tesorería General de la Seguridad Social",
        category: "SOCIAL_SECURITY",
        grossCents: settings.retaMonthlyCuotaCents,
        netCents: settings.retaMonthlyCuotaCents,
        vatRate: 0,
        vatCents: 0,
        deductiblePct: 100,
        deductibleNetCents: settings.retaMonthlyCuotaCents,
        deductibleVatCents: 0,
        status: "CONFIRMED",
        source: "AUTO_RETA",
        retaYearMonth: tag,
        notes: "Auto-generated RETA cuota (100% IRPF-deductible).",
      },
    });
    created++;
  }
  return { created };
}
