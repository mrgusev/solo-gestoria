import { prisma } from "./db";
import type { ExpenseCategory } from "@prisma/client";

export type Quarter = 1 | 2 | 3 | 4;

export function quarterOf(d: Date): Quarter {
  const m = d.getUTCMonth() + 1;
  return (Math.ceil(m / 3) as Quarter);
}

export function quarterRange(year: number, q: Quarter): { start: Date; endExclusive: Date } {
  const startMonth = (q - 1) * 3;
  const start = new Date(Date.UTC(year, startMonth, 1));
  const endExclusive = new Date(Date.UTC(year, startMonth + 3, 1));
  return { start, endExclusive };
}

export function ytdRangeThroughQuarter(year: number, q: Quarter): { start: Date; endExclusive: Date } {
  const start = new Date(Date.UTC(year, 0, 1));
  const endExclusive = new Date(Date.UTC(year, q * 3, 1));
  return { start, endExclusive };
}

type ExpenseRow = {
  netCents: number;
  vatCents: number;
  deductibleNetCents: number;
  deductibleVatCents: number;
  category: ExpenseCategory;
};

type InvoiceRow = {
  totalCents: number;
  subtotalCents: number;
  clientCountryCode: string;
  clientVatId: string | null;
};

async function fetchExpenses(start: Date, endExclusive: Date): Promise<ExpenseRow[]> {
  return prisma.expense.findMany({
    where: { status: "CONFIRMED", date: { gte: start, lt: endExclusive } },
    select: {
      netCents: true,
      vatCents: true,
      deductibleNetCents: true,
      deductibleVatCents: true,
      category: true,
    },
  });
}

async function fetchInvoices(start: Date, endExclusive: Date): Promise<InvoiceRow[]> {
  const rows = await prisma.invoice.findMany({
    where: { date: { gte: start, lt: endExclusive } },
    select: {
      totalCents: true,
      subtotalCents: true,
      client: { select: { countryCode: true, vatId: true } },
    },
  });
  return rows.map((r) => ({
    totalCents: r.totalCents,
    subtotalCents: r.subtotalCents,
    clientCountryCode: r.client.countryCode,
    clientVatId: r.client.vatId,
  }));
}

export type QuarterReport = {
  year: number;
  quarter: Quarter;
  // Raw per-quarter totals (this quarter only)
  period: {
    incomeCents: number;
    deductibleNetCents: number;
    deductibleVatCents: number;
    deductibleNetWithVatCents: number; // subset where vat > 0 (for MOD 303 box 28)
  };
  // Year-to-date through end-of-quarter
  ytd: {
    incomeCents: number;
    deductibleNetCents: number;
  };
  // Per-quarter prior payments (sum of MOD 130 box 07 for prior quarters of same year)
  priorMod130PaymentsCents: number;
  // MOD 130 boxes (selected; missing ones are 0 in our scenario)
  mod130: {
    box01: number; // YTD income
    box02: number; // YTD deductible expenses
    box03: number; // 01 - 02
    box04: number; // max(0, 0.20 * 03)
    box05: number; // sum of prior box 07 - prior box 16 (we treat box 16 = 0)
    box06: number; // withholdings YTD (0 for intra-EU customer with no withholding)
    box07: number; // 04 - 05 - 06
    box12: number; // 07 + 11 (11 = 0 for us)
    box14: number; // 12 - 13 (13 = 0 for us)
    box17: number; // 14 - 15 - 16 (15 = 16 = 0)
    box19: number; // 17 - 18 (18 = 0 for new declarations)
  };
  // MOD 303 boxes
  mod303: {
    box27: number; // total cuota devengada (0 if all sales intra-EU exempt)
    box28: number; // base imponible deducible operaciones interiores
    box29: number; // cuota deducible operaciones interiores
    box45: number; // total a deducir
    box46: number; // resultado régimen general (27 - 45)
    box59: number; // entregas intracomunitarias de bienes y servicios
    box64: number; // suma resultados (46 + 58 + 76); 58, 76 = 0 for us
    box66: number; // atribuible al Estado (= 64 * 100%)
    box69: number; // resultado autoliquidación
    box71: number; // resultado final (= 69 currently, no prior adjustments)
    box72: number; // a compensar (only when 71 < 0, magnitude)
  };
  // MOD 349 — intra-EU operators
  mod349: Array<{
    countryCode: string;
    vatNumberWithoutPrefix: string;
    name: string;
    clave: "S" | "E" | "A" | "T" | "C" | "M" | "H" | "R" | "D"; // S = services rendered
    baseCents: number;
  }>;
};

export async function computeQuarterReport(
  year: number,
  quarter: Quarter
): Promise<QuarterReport> {
  const { start: qStart, endExclusive: qEnd } = quarterRange(year, quarter);
  const { start: yStart, endExclusive: yEnd } = ytdRangeThroughQuarter(year, quarter);

  const [qExpenses, qInvoices, ytdExpenses, ytdInvoices] = await Promise.all([
    fetchExpenses(qStart, qEnd),
    fetchInvoices(qStart, qEnd),
    fetchExpenses(yStart, yEnd),
    fetchInvoices(yStart, yEnd),
  ]);

  const qIncome = qInvoices.reduce((s, r) => s + r.totalCents, 0);
  const qDeductibleNet = qExpenses.reduce((s, r) => s + r.deductibleNetCents, 0);
  const qDeductibleVat = qExpenses.reduce((s, r) => s + r.deductibleVatCents, 0);
  const qDeductibleNetWithVat = qExpenses
    .filter((r) => r.vatCents > 0)
    .reduce((s, r) => s + r.deductibleNetCents, 0);

  const ytdIncome = ytdInvoices.reduce((s, r) => s + r.totalCents, 0);
  const ytdDeductibleNet = ytdExpenses.reduce((s, r) => s + r.deductibleNetCents, 0);

  // Prior MOD 130 payments this year: recursive but bounded to up to 3 prior quarters.
  let priorPayments = 0;
  for (let q = 1; q < quarter; q++) {
    const prior = await computeQuarterReport(year, q as Quarter);
    if (prior.mod130.box07 > 0) priorPayments += prior.mod130.box07;
  }

  const box01 = ytdIncome;
  const box02 = ytdDeductibleNet;
  const box03 = box01 - box02;
  const box04 = Math.max(0, Math.round(box03 * 0.2));
  const box05 = priorPayments;
  const box06 = 0;
  const box07 = box04 - box05 - box06;
  const box12 = box07; // box 11 = 0 for non-agricultural activity
  const box14 = box12; // box 13 = 0
  const box17 = box14; // box 15 = 16 = 0
  const box19 = box17;

  const intraEU = qInvoices.filter(
    (r) => r.clientCountryCode !== "ES" && (r.clientVatId ?? "").length > 0
  );
  const box59 = intraEU.reduce((s, r) => s + r.totalCents, 0);

  const box27 = 0;
  const box28 = qDeductibleNetWithVat;
  const box29 = qDeductibleVat;
  const box45 = box29;
  const box46 = box27 - box45;
  const box64 = box46;
  const box66 = box64;
  const box69 = box66;
  const box71 = box69;
  const box72 = box71 < 0 ? -box71 : 0;

  // MOD 349: aggregate per intra-EU client.
  const byClient = new Map<
    string,
    { countryCode: string; vatNumberWithoutPrefix: string; name: string; baseCents: number }
  >();
  const intraInvoices = await prisma.invoice.findMany({
    where: {
      date: { gte: qStart, lt: qEnd },
      client: { countryCode: { not: "ES" } },
    },
    select: {
      totalCents: true,
      client: { select: { name: true, vatId: true, countryCode: true } },
    },
  });
  for (const inv of intraInvoices) {
    const vat = inv.client.vatId ?? "";
    if (!vat) continue;
    const prefix = vat.slice(0, 2);
    const numberOnly = vat.startsWith(prefix) ? vat.slice(2) : vat;
    const key = inv.client.countryCode + ":" + vat;
    const cur = byClient.get(key) ?? {
      countryCode: inv.client.countryCode,
      vatNumberWithoutPrefix: numberOnly,
      name: inv.client.name,
      baseCents: 0,
    };
    cur.baseCents += inv.totalCents;
    byClient.set(key, cur);
  }
  const mod349 = Array.from(byClient.values()).map((c) => ({ ...c, clave: "S" as const }));

  return {
    year,
    quarter,
    period: {
      incomeCents: qIncome,
      deductibleNetCents: qDeductibleNet,
      deductibleVatCents: qDeductibleVat,
      deductibleNetWithVatCents: qDeductibleNetWithVat,
    },
    ytd: {
      incomeCents: ytdIncome,
      deductibleNetCents: ytdDeductibleNet,
    },
    priorMod130PaymentsCents: priorPayments,
    mod130: { box01, box02, box03, box04, box05, box06, box07, box12, box14, box17, box19 },
    mod303: { box27, box28, box29, box45, box46, box59, box64, box66, box69, box71, box72 },
    mod349,
  };
}
