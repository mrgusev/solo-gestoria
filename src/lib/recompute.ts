import { prisma } from "./db";
import { applyDeduction, defaultDeductiblePct } from "./deduction";

// Recompute deductiblePct + amounts for every CONFIRMED expense based on the
// current Settings + category rules. Returns the number of rows touched.
// Safe to call after any setting change that affects deduction rules
// (homeOfficePct change).
export async function recomputeAllExpenseDeductions(): Promise<{ updated: number }> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) return { updated: 0 };

  const rows = await prisma.expense.findMany({ where: { status: "CONFIRMED" } });
  let updated = 0;
  for (const e of rows) {
    const pct = defaultDeductiblePct(e.category, settings, e.date);
    const ded = applyDeduction(pct, e.netCents, e.vatCents);
    if (
      pct !== e.deductiblePct ||
      ded.deductibleNetCents !== e.deductibleNetCents ||
      ded.deductibleVatCents !== e.deductibleVatCents
    ) {
      await prisma.expense.update({
        where: { id: e.id },
        data: {
          deductiblePct: pct,
          deductibleNetCents: ded.deductibleNetCents,
          deductibleVatCents: ded.deductibleVatCents,
        },
      });
      updated++;
    }
  }
  return { updated };
}
