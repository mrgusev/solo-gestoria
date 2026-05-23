// Pure data fetchers for the dashboard. Kept free of the `server-only`
// directive so plain Node scripts (e.g. `scripts/bot-poll.ts`) can import
// them. React-server consumers should import from `./dashboard` instead,
// which re-exports these with the `server-only` guard applied.
import { prisma } from "./db";
import { MONTH_LABELS, type MonthPoint } from "./dashboard-shared";

export async function monthlyTotals(year: number): Promise<MonthPoint[]> {
  const start = new Date(Date.UTC(year, 0, 1));
  const endExclusive = new Date(Date.UTC(year + 1, 0, 1));
  const [invoices, expenses] = await Promise.all([
    prisma.invoice.findMany({
      where: { date: { gte: start, lt: endExclusive } },
      select: { date: true, totalCents: true },
    }),
    prisma.expense.findMany({
      where: { status: "CONFIRMED", date: { gte: start, lt: endExclusive } },
      select: {
        date: true,
        category: true,
        deductibleNetCents: true,
        deductibleVatCents: true,
      },
    }),
  ]);

  const months: MonthPoint[] = MONTH_LABELS.map((label, i) => ({
    monthIndex: i,
    label,
    incomeCents: 0,
    totalDeductibleCents: 0,
    byCategory: {},
  }));

  for (const inv of invoices) {
    months[inv.date.getUTCMonth()].incomeCents += inv.totalCents;
  }
  for (const e of expenses) {
    const ded = e.deductibleNetCents + e.deductibleVatCents;
    if (ded <= 0) continue;
    const m = e.date.getUTCMonth();
    months[m].totalDeductibleCents += ded;
    months[m].byCategory[e.category] = (months[m].byCategory[e.category] ?? 0) + ded;
  }
  return months;
}

export async function activeYearsList(): Promise<number[]> {
  const [invMin, invMax, expMin, expMax] = await Promise.all([
    prisma.invoice.findFirst({ orderBy: { date: "asc" }, select: { date: true } }),
    prisma.invoice.findFirst({ orderBy: { date: "desc" }, select: { date: true } }),
    prisma.expense.findFirst({ orderBy: { date: "asc" }, select: { date: true } }),
    prisma.expense.findFirst({ orderBy: { date: "desc" }, select: { date: true } }),
  ]);
  const dates = [invMin?.date, invMax?.date, expMin?.date, expMax?.date].filter(
    (d): d is Date => d != null
  );
  if (dates.length === 0) return [new Date().getUTCFullYear()];
  const minY = Math.min(...dates.map((d) => d.getUTCFullYear()));
  const maxY = Math.max(...dates.map((d) => d.getUTCFullYear()));
  const out: number[] = [];
  for (let y = minY; y <= maxY; y++) out.push(y);
  return out;
}
