// Invoice arithmetic. Deliberately free of any prisma/server import so the
// live preview in the browser and the server actions compute totals with the
// exact same code — a mismatch there would put the PDF and the AEAT fichero
// a cent apart.
//
// Rates are fractions (0.21, 0.15), matching InvoiceLine.vatRate.

export type TotalsLineInput = {
  quantity: number;
  unitPriceCents: number;
  vatRate: number;
};

export type VatRateGroup = {
  rate: number;
  baseCents: number;
  cuotaCents: number;
};

export type InvoiceTotals = {
  subtotalCents: number;
  vatCents: number;
  irpfCents: number;
  totalCents: number;
  // Bases and cuotas grouped per VAT rate — this is exactly how MOD 303
  // reports IVA devengado, so grouping here keeps the invoice and the fichero
  // consistent to the cent.
  vatByRate: VatRateGroup[];
};

export function lineNetCents(line: { quantity: number; unitPriceCents: number }): number {
  return Math.round(line.quantity * line.unitPriceCents);
}

export function computeInvoiceTotals(
  lines: TotalsLineInput[],
  irpfRate = 0
): InvoiceTotals {
  // Group by rate first, then round the cuota once per group (not per line):
  // rounding per line and summing can drift a cent away from what MOD 303
  // expects, since the form only ever sees the per-rate base.
  const byRate = new Map<number, number>();
  let subtotalCents = 0;
  for (const line of lines) {
    const net = lineNetCents(line);
    subtotalCents += net;
    const rate = line.vatRate || 0;
    byRate.set(rate, (byRate.get(rate) ?? 0) + net);
  }

  const vatByRate: VatRateGroup[] = Array.from(byRate.entries())
    .filter(([rate]) => rate > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([rate, baseCents]) => ({
      rate,
      baseCents,
      cuotaCents: Math.round(baseCents * rate),
    }));

  const vatCents = vatByRate.reduce((s, g) => s + g.cuotaCents, 0);
  const irpfCents = irpfRate > 0 ? Math.round(subtotalCents * irpfRate) : 0;

  return {
    subtotalCents,
    vatCents,
    irpfCents,
    // The retención is money the client pays to Hacienda on our behalf, so it
    // comes off the amount actually transferred.
    totalCents: subtotalCents + vatCents - irpfCents,
    vatByRate,
  };
}

// Percent <-> fraction conversion at the UI boundary. Rates live as fractions
// everywhere in the DB; forms show percentages.
export function pctToRate(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  // Round to 4 decimals so 21 -> 0.21 exactly, and odd rates like 5.2% survive.
  return Math.round(pct * 100) / 10000;
}

export function rateToPct(rate: number): number {
  if (!Number.isFinite(rate)) return 0;
  return Math.round(rate * 10000) / 100;
}
