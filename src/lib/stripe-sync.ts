// Pulls sales invoices, credit notes and processing fees from Stripe into the
// local books so the quarterly reports count them automatically.
//
//   Stripe invoice (open/paid/uncollectible) → Invoice (source STRIPE, locked)
//   Stripe credit note (issued)              → Invoice with negative amounts
//                                              (factura rectificativa)
//   Stripe processing fees                   → one BANK_FEES Expense per month
//
// Each invoice is classified for Spanish VAT from the tax Stripe actually
// charged (see classify()), which drives MOD 303 / 349 / 369 in src/lib/tax.ts.
//
// Idempotent: rows are keyed by Stripe id (Invoice.stripeId) or month
// (Expense.stripeFeeMonth) and only rewritten when the numbers change.
// Uses plain fetch against the REST API; the key needs read access to
// Invoices, Credit notes, Customers, Tax rates and Balance transactions.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { VatTreatment } from "@prisma/client";
import { prisma } from "./db";
import { isEuCountry } from "./clients";
import { legalLockDate } from "./invoice-lock";
import { applyDeduction, defaultDeductiblePct } from "./deduction";

const API = "https://api.stripe.com/v1";
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "./uploads";

// ---------- Stripe shapes (only the fields we read) ----------

type List<T> = { data: T[]; has_more: boolean };

type TaxRate = { id: string; country: string | null; percentage: number };

// New API (`total_taxes` / line `taxes`) and legacy (`total_tax_amounts` /
// line `tax_amounts`) shapes — accept both so the account's API version
// doesn't matter.
type TaxAmount = {
  amount: number;
  tax_behavior?: "inclusive" | "exclusive" | null;
  inclusive?: boolean;
  taxability_reason?: string | null;
  tax_rate_details?: { tax_rate: string | TaxRate } | null;
  tax_rate?: string | TaxRate;
};

type Line = {
  description: string | null;
  amount: number;
  quantity: number | null;
  discount_amounts?: { amount: number }[] | null;
  taxes?: TaxAmount[] | null;
  tax_amounts?: TaxAmount[] | null;
};

type Address = {
  line1?: string | null;
  line2?: string | null;
  postal_code?: string | null;
  city?: string | null;
  country?: string | null;
};

type StripeInvoice = {
  id: string;
  number: string | null;
  status: "draft" | "open" | "paid" | "uncollectible" | "void";
  livemode: boolean;
  currency: string;
  created: number;
  due_date: number | null;
  status_transitions?: { finalized_at: number | null } | null;
  total: number;
  total_excluding_tax: number | null;
  customer: string | { id: string } | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_address: Address | null;
  customer_tax_ids: { type: string; value: string }[] | null;
  total_taxes?: TaxAmount[] | null;
  total_tax_amounts?: TaxAmount[] | null;
  invoice_pdf: string | null;
  lines: List<Line>;
};

type StripeCreditNote = {
  id: string;
  number: string;
  status: "issued" | "void";
  livemode: boolean;
  currency: string;
  created: number;
  effective_at?: number | null;
  invoice: string;
  total: number;
  total_excluding_tax: number | null;
  pdf: string | null;
  lines: List<Line>;
};

type BalanceTransaction = {
  id: string;
  type: string;
  amount: number;
  fee: number;
  currency: string;
  created: number;
};

// ---------- HTTP ----------

function stripeKey(): string {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set.");
  return key;
}

export function stripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY?.trim();
}

// Minutes between automatic syncs (run by the bot worker's cron).
export function stripeSyncIntervalMin(): number {
  return Math.max(5, Number(process.env.STRIPE_SYNC_INTERVAL_MIN ?? 60) || 60);
}

async function get<T>(pathAndQuery: string): Promise<T> {
  const res = await fetch(`${API}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${stripeKey()}` },
    cache: "no-store",
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe ${pathAndQuery.split("?")[0]}: ${body?.error?.message ?? res.status}`);
  }
  return body as T;
}

async function listAll<T extends { id: string }>(resource: string, query = ""): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (;;) {
    const qs = new URLSearchParams(query);
    qs.set("limit", "100");
    if (after) qs.set("starting_after", after);
    const page = await get<List<T>>(`/${resource}?${qs}`);
    out.push(...page.data);
    if (!page.has_more || page.data.length === 0) return out;
    after = page.data[page.data.length - 1].id;
  }
}

const taxRateCache = new Map<string, TaxRate>();

async function taxRate(ref: string | TaxRate | undefined): Promise<TaxRate | null> {
  if (!ref) return null;
  if (typeof ref !== "string") {
    taxRateCache.set(ref.id, ref);
    return ref;
  }
  const cached = taxRateCache.get(ref);
  if (cached) return cached;
  const rate = await get<TaxRate>(`/tax_rates/${ref}`);
  taxRateCache.set(ref, rate);
  return rate;
}

function rateRef(t: TaxAmount): string | TaxRate | undefined {
  return t.tax_rate_details?.tax_rate ?? t.tax_rate;
}

// ---------- Helpers ----------

// Calendar date in Madrid (an invoice finalized 23:30 UTC on 31 Mar is a
// 1 Apr invoice for AEAT), stored at 12:00 UTC like the rest of the app.
function madridDate(unixSeconds: number): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(unixSeconds * 1000));
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

function countryName(cc: string): string {
  if (!cc) return "";
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(cc) ?? cc;
  } catch {
    return cc;
  }
}

function customerId(c: StripeInvoice["customer"]): string | null {
  if (!c) return null;
  return typeof c === "string" ? c : c.id;
}

async function lineVatRate(line: Line): Promise<number> {
  const taxes = line.taxes ?? line.tax_amounts ?? [];
  const taxed = taxes.find((t) => t.amount !== 0);
  if (!taxed) return 0;
  const rate = await taxRate(rateRef(taxed));
  return rate ? rate.percentage / 100 : 0;
}

async function allInvoiceLines(inv: StripeInvoice): Promise<Line[]> {
  if (!inv.lines.has_more) return inv.lines.data;
  return listAll<Line & { id: string }>(`invoices/${inv.id}/lines`);
}

async function allCreditNoteLines(cn: StripeCreditNote): Promise<Line[]> {
  if (!cn.lines.has_more) return cn.lines.data;
  return listAll<Line & { id: string }>(`credit_notes/${cn.id}/lines`);
}

async function toInvoiceLines(lines: Line[], sign: 1 | -1) {
  return Promise.all(
    lines.map(async (l, i) => {
      const discount = (l.discount_amounts ?? []).reduce((s, d) => s + d.amount, 0);
      // Tax-inclusive prices carry the VAT inside `amount`; strip it to get the base.
      const inclusiveTax = (l.taxes ?? l.tax_amounts ?? [])
        .filter((t) => t.tax_behavior === "inclusive" || t.inclusive === true)
        .reduce((s, t) => s + t.amount, 0);
      const net = sign * (l.amount - discount - inclusiveTax);
      const qty = l.quantity && l.quantity > 0 ? l.quantity : 1;
      return {
        position: i + 1,
        description: l.description ?? "Stripe item",
        quantity: qty,
        unit: "u",
        unitPriceCents: Math.round(net / qty),
        vatRate: await lineVatRate(l),
        netCents: net,
      };
    })
  );
}

// Decide the Spanish VAT treatment from what Stripe charged.
async function classify(
  inv: StripeInvoice
): Promise<{ treatment: VatTreatment; vatCountryCode: string | null; warning?: string }> {
  const taxes = inv.total_taxes ?? inv.total_tax_amounts ?? [];
  const cc = (inv.customer_address?.country ?? "").toUpperCase();
  const hasVatId = (inv.customer_tax_ids ?? []).some((t) => t.type === "eu_vat");
  const label = inv.number ?? inv.id;

  const taxed = taxes.find((t) => t.amount !== 0);
  if (taxed) {
    const rate = await taxRate(rateRef(taxed));
    const taxCc = (rate?.country ?? cc).toUpperCase();
    if (taxCc === "ES") return { treatment: "DOMESTIC_ES", vatCountryCode: "ES" };
    if (isEuCountry(taxCc)) return { treatment: "OSS_EU_B2C", vatCountryCode: taxCc };
    return {
      treatment: "EXPORT_NON_EU",
      vatCountryCode: taxCc || null,
      warning: `${label}: Stripe charged non-EU tax (${taxCc}) — not reported in Spain, check it.`,
    };
  }

  const reverseCharge = taxes.some((t) => t.taxability_reason === "reverse_charge");
  if (cc !== "ES" && isEuCountry(cc) && (reverseCharge || hasVatId)) {
    return { treatment: "INTRA_EU_REVERSE_CHARGE", vatCountryCode: null };
  }
  if (cc && !isEuCountry(cc)) return { treatment: "EXPORT_NON_EU", vatCountryCode: null };
  // A €0 invoice (e.g. 100% discount) has no VAT to charge — nothing to flag.
  if ((inv.total_excluding_tax ?? inv.total) === 0) {
    return { treatment: "DOMESTIC_ES", vatCountryCode: "ES" };
  }
  return {
    treatment: "DOMESTIC_ES",
    vatCountryCode: "ES",
    warning: `${label}: no VAT was charged on a sale to ${cc || "an unknown country"} — check Stripe Tax.`,
  };
}

function exemptionNoteFor(t: VatTreatment): string | null {
  switch (t) {
    case "INTRA_EU_REVERSE_CHARGE":
      return "Reverse charge — art. 196 Directive 2006/112/EC; art. 69.Uno.1º Ley 37/1992.";
    case "EXPORT_NON_EU":
      return "Not subject to Spanish VAT — place of supply outside Spain (art. 69 Ley 37/1992).";
    default:
      return null;
  }
}

async function upsertClient(
  inv: StripeInvoice,
  fallbackCountry: string | null,
  treatment: VatTreatment
): Promise<string> {
  const custId = customerId(inv.customer) ?? `email:${inv.customer_email ?? inv.id}`;
  const a = inv.customer_address ?? {};
  const cc = (a.country ?? fallbackCountry ?? "").toUpperCase();
  const taxIds = inv.customer_tax_ids ?? [];
  const euVat = taxIds.find((t) => t.type === "eu_vat")?.value.toUpperCase() ?? null;
  const esNif =
    taxIds.find((t) => t.type === "es_cif")?.value.toUpperCase() ??
    (euVat?.startsWith("ES") ? euVat.slice(2) : null);
  const data = {
    name: (inv.customer_name || inv.customer_email || custId).trim(),
    taxId: esNif,
    vatId: euVat,
    countryCode: cc,
    addressLine: [a.line1, a.line2].filter(Boolean).join(", "),
    postalCode: a.postal_code ?? "",
    city: a.city ?? "",
    country: countryName(cc),
    email: inv.customer_email,
    vatTreatment: treatment,
    invoiceLocale: cc === "ES" ? "es" : "en",
  };
  // One Stripe customer can be billed under different identities over time
  // (a person, later their company with a NIF). Each identity is its own
  // client, so an invoice always shows who it was actually issued to.
  const identity = (esNif ?? euVat ?? data.name).toUpperCase().replace(/\s+/g, " ");
  const key = `${custId}|${identity}`;
  const client = await prisma.client.upsert({
    where: { stripeCustomerId: key },
    create: { ...data, stripeCustomerId: key, notes: `Created from Stripe customer ${custId}` },
    update: data,
    select: { id: true },
  });
  return client.id;
}

async function downloadPdf(url: string | null, stripeId: string): Promise<string | null> {
  if (!url) return null;
  const relPath = path.join("invoices", "stripe", `${stripeId}.pdf`);
  const abs = path.join(UPLOAD_DIR, relPath);
  try {
    await fs.access(abs);
    return relPath;
  } catch {
    /* not downloaded yet */
  }
  try {
    const res = await fetch(url, { redirect: "follow", cache: "no-store" });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 4).toString() !== "%PDF") return null;
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buf);
    return relPath;
  } catch {
    return null; // retried on the next sync
  }
}

type InvoiceData = {
  number: string;
  date: Date;
  dueDate: Date;
  clientId: string;
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
  vatExempt: boolean;
  exemptionNote: string | null;
  vatTreatment: VatTreatment;
  vatCountryCode: string | null;
  stripeLivemode: boolean;
  notes: string;
};

type LineData = Awaited<ReturnType<typeof toInvoiceLines>>;

// Create or update one STRIPE invoice row. Returns what happened.
async function writeInvoice(
  stripeId: string,
  data: InvoiceData,
  lines: LineData,
  pdfUrl: string | null
): Promise<"created" | "updated" | "unchanged"> {
  const existing = await prisma.invoice.findUnique({ where: { stripeId } });
  const pdfPath = await downloadPdf(pdfUrl, stripeId);

  if (!existing) {
    await prisma.invoice.create({
      data: {
        ...data,
        currency: "EUR",
        source: "STRIPE",
        stripeId,
        pdfPath,
        lines: { create: lines },
      },
    });
    return "created";
  }

  const same =
    existing.number === data.number &&
    existing.date.getTime() === data.date.getTime() &&
    existing.clientId === data.clientId &&
    existing.subtotalCents === data.subtotalCents &&
    existing.vatCents === data.vatCents &&
    existing.totalCents === data.totalCents &&
    existing.vatTreatment === data.vatTreatment &&
    existing.vatCountryCode === data.vatCountryCode;
  if (same) {
    if (pdfPath && existing.pdfPath !== pdfPath) {
      await prisma.invoice.update({ where: { id: existing.id }, data: { pdfPath } });
    }
    return "unchanged";
  }
  await prisma.$transaction([
    prisma.invoiceLine.deleteMany({ where: { invoiceId: existing.id } }),
    prisma.invoice.update({
      where: { id: existing.id },
      data: { ...data, pdfPath: pdfPath ?? existing.pdfPath, lines: { create: lines } },
    }),
  ]);
  return "updated";
}

// Remove a STRIPE row whose Stripe document was voided — unless its quarter
// is already filed, in which case it needs a human (rectificativa).
async function removeVoided(stripeId: string, label: string, warnings: string[]): Promise<boolean> {
  const existing = await prisma.invoice.findUnique({ where: { stripeId } });
  if (!existing) return false;
  if (Date.now() >= legalLockDate(existing.date).getTime()) {
    warnings.push(
      `${label} was voided in Stripe after its quarter was filed — kept here; amend via rectificativa.`
    );
    return false;
  }
  await prisma.invoice.delete({ where: { id: existing.id } });
  return true;
}

// ---------- Sync ----------

export type StripeSyncResult = {
  invoices: { created: number; updated: number; unchanged: number; removed: number };
  creditNotes: { created: number; updated: number; unchanged: number; removed: number };
  feeMonths: number;
  warnings: string[];
};

async function syncInvoices(result: StripeSyncResult): Promise<void> {
  // Oldest first, so a client row ends up with its most recent details.
  const invoices = (await listAll<StripeInvoice>("invoices")).sort((a, b) => a.created - b.created);
  for (const inv of invoices) {
    const label = inv.number ?? inv.id;
    if (inv.status === "draft") continue;
    if (inv.status === "void") {
      if (await removeVoided(inv.id, label, result.warnings)) result.invoices.removed++;
      continue;
    }
    if (inv.currency.toLowerCase() !== "eur") {
      result.warnings.push(`${label}: currency ${inv.currency.toUpperCase()} not imported (books are in EUR).`);
      continue;
    }
    const { treatment, vatCountryCode, warning } = await classify(inv);
    if (warning) result.warnings.push(warning);

    const issued = madridDate(inv.status_transitions?.finalized_at ?? inv.created);
    const subtotal = inv.total_excluding_tax ?? inv.total;
    const lines = await toInvoiceLines(await allInvoiceLines(inv), 1);
    const outcome = await writeInvoice(
      inv.id,
      {
        number: inv.number ?? inv.id,
        date: issued,
        dueDate: inv.due_date ? madridDate(inv.due_date) : issued,
        clientId: await upsertClient(inv, vatCountryCode, treatment),
        subtotalCents: subtotal,
        vatCents: inv.total - subtotal,
        totalCents: inv.total,
        vatExempt: inv.total === subtotal,
        exemptionNote: exemptionNoteFor(treatment),
        vatTreatment: treatment,
        vatCountryCode,
        stripeLivemode: inv.livemode,
        notes: `Stripe ${inv.id} (${inv.status})`,
      },
      lines,
      inv.invoice_pdf
    );
    result.invoices[outcome]++;
  }
}

async function syncCreditNotes(result: StripeSyncResult): Promise<void> {
  const notes = await listAll<StripeCreditNote>("credit_notes");
  for (const cn of notes) {
    if (cn.status === "void") {
      if (await removeVoided(cn.id, cn.number, result.warnings)) result.creditNotes.removed++;
      continue;
    }
    if (cn.currency.toLowerCase() !== "eur") {
      result.warnings.push(`${cn.number}: currency ${cn.currency.toUpperCase()} not imported.`);
      continue;
    }
    // A rectificativa inherits client + VAT treatment from the invoice it corrects.
    const parent = await prisma.invoice.findUnique({ where: { stripeId: cn.invoice } });
    if (!parent) {
      result.warnings.push(`${cn.number}: original invoice ${cn.invoice} not in the books — skipped.`);
      continue;
    }
    const issued = madridDate(cn.effective_at ?? cn.created);
    const subtotal = cn.total_excluding_tax ?? cn.total;
    const lines = await toInvoiceLines(await allCreditNoteLines(cn), -1);
    const outcome = await writeInvoice(
      cn.id,
      {
        number: cn.number,
        date: issued,
        dueDate: issued,
        clientId: parent.clientId,
        subtotalCents: -subtotal,
        vatCents: -(cn.total - subtotal),
        totalCents: -cn.total,
        vatExempt: cn.total === subtotal,
        exemptionNote: parent.exemptionNote,
        vatTreatment: parent.vatTreatment,
        vatCountryCode: parent.vatCountryCode,
        stripeLivemode: cn.livemode,
        notes: `Stripe credit note ${cn.id} — rectifies ${parent.number}`,
      },
      lines,
      cn.pdf
    );
    result.creditNotes[outcome]++;
  }
}

// Stripe processing fees, aggregated per (Madrid) month into one expense.
// Payment-processing fees are VAT-exempt financial services, so the whole
// amount is net with 0 VAT; it's a 100% deductible IRPF expense.
async function syncFees(result: StripeSyncResult): Promise<void> {
  const txns = await listAll<BalanceTransaction>("balance_transactions");
  const byMonth = new Map<string, number>();
  for (const t of txns) {
    // Fees deducted from a payment, plus standalone Stripe fee debits
    // (Billing / Tax / Radar usage).
    const fee = t.type === "stripe_fee" ? -t.amount : t.fee;
    if (!fee) continue;
    if (t.currency.toLowerCase() !== "eur") {
      result.warnings.push(`Fee on ${t.id} in ${t.currency.toUpperCase()} not imported.`);
      continue;
    }
    const d = madridDate(t.created);
    const month = d.toISOString().slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + fee);
  }

  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) return;
  for (const [month, cents] of byMonth) {
    const [y, m] = month.split("-").map(Number);
    const date = new Date(Date.UTC(y, m, 0, 12)); // last day of the month
    const pct = defaultDeductiblePct("BANK_FEES", settings, date);
    const ded = applyDeduction(pct, cents, 0);
    const data = {
      date,
      vendor: "Stripe Payments Europe, Ltd.",
      category: "BANK_FEES" as const,
      grossCents: cents,
      netCents: cents,
      vatRate: 0,
      vatCents: 0,
      deductiblePct: pct,
      deductibleNetCents: ded.deductibleNetCents,
      deductibleVatCents: ded.deductibleVatCents,
      status: "CONFIRMED" as const,
      source: "STRIPE_FEES" as const,
      notes: `Stripe processing fees for ${month} (auto-synced from balance transactions).`,
    };
    const existing = await prisma.expense.findUnique({ where: { stripeFeeMonth: month } });
    if (existing && existing.grossCents === cents && existing.deductiblePct === pct) continue;
    await prisma.expense.upsert({
      where: { stripeFeeMonth: month },
      create: { ...data, stripeFeeMonth: month },
      update: data,
    });
    result.feeMonths++;
  }
}

async function runSync(): Promise<StripeSyncResult> {
  const key = stripeKey();
  if (/^(sk|rk)_test_/.test(key) && process.env.STRIPE_ALLOW_TEST_DATA !== "true") {
    throw new Error(
      "STRIPE_SECRET_KEY is a test-mode key. Refusing to mix test data into the books — " +
        "use a live key, or set STRIPE_ALLOW_TEST_DATA=true on a throwaway database."
    );
  }
  const result: StripeSyncResult = {
    invoices: { created: 0, updated: 0, unchanged: 0, removed: 0 },
    creditNotes: { created: 0, updated: 0, unchanged: 0, removed: 0 },
    feeMonths: 0,
    warnings: [],
  };
  await syncInvoices(result);
  await syncCreditNotes(result);
  await syncFees(result);
  // Drop Stripe clients no invoice points at any more (e.g. after a void).
  await prisma.client.deleteMany({
    where: { stripeCustomerId: { not: null }, invoices: { none: {} }, recurring: { none: {} } },
  });
  return result;
}

export function summarizeSync(r: StripeSyncResult): string {
  return (
    `Invoices: ${r.invoices.created} new, ${r.invoices.updated} updated, ${r.invoices.removed} voided. ` +
    `Credit notes: ${r.creditNotes.created} new, ${r.creditNotes.updated} updated. ` +
    `Fee months updated: ${r.feeMonths}.` +
    (r.warnings.length ? `\n⚠ ${r.warnings.join("\n⚠ ")}` : "")
  );
}

// Single-flight: the interval timer and a "Sync now" click never overlap.
const g = globalThis as unknown as { __stripeSync?: Promise<StripeSyncResult> };

export async function syncStripe(): Promise<StripeSyncResult> {
  if (g.__stripeSync) return g.__stripeSync;
  g.__stripeSync = (async () => {
    try {
      const result = await runSync();
      await prisma.settings.updateMany({
        where: { id: 1 },
        data: {
          stripeLastSyncAt: new Date(),
          stripeLastSyncSummary: summarizeSync(result),
          stripeLastSyncError: null,
        },
      });
      return result;
    } catch (err) {
      await prisma.settings
        .updateMany({
          where: { id: 1 },
          data: { stripeLastSyncAt: new Date(), stripeLastSyncError: String((err as Error).message ?? err) },
        })
        .catch(() => {});
      throw err;
    } finally {
      g.__stripeSync = undefined;
    }
  })();
  return g.__stripeSync;
}
