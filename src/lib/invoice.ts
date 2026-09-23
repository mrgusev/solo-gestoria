import { promises as fs } from "node:fs";
import path from "node:path";
import type { Client, Settings, VatTreatment } from "@prisma/client";
import { prisma } from "./db";
import { computeInvoiceTotals, lineNetCents } from "./invoice-totals";
import { resolveBankAccountId } from "./bank-accounts-db";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "./uploads";

// Resolve the on-disk path for an invoice PDF, relative to UPLOAD_DIR.
export function invoicePdfRelPath(invoiceId: string): string {
  return path.join("invoices", `${invoiceId}.pdf`);
}

// Render an invoice's PDF and persist it under uploads/invoices/<id>.pdf,
// then set Invoice.pdfPath. Idempotent — safe to call on create + every edit.
// Defined here as a separate function so callers can call it from a server
// context only (renderInvoicePdf pulls in @react-pdf/renderer).
async function persistInvoicePdf(invoiceId: string): Promise<void> {
  const { renderInvoicePdf } = await import("./invoice-pdf");
  const [invoice, settings] = await Promise.all([
    prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        lines: { orderBy: { position: "asc" } },
        client: true,
        bankAccount: true,
      },
    }),
    prisma.settings.findUnique({ where: { id: 1 } }),
  ]);
  if (!invoice || !settings) return;
  const pdf = await renderInvoicePdf({ invoice, settings });
  const relPath = invoicePdfRelPath(invoice.id);
  await fs.mkdir(path.join(UPLOAD_DIR, "invoices"), { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, relPath), pdf);
  if (invoice.pdfPath !== relPath) {
    await prisma.invoice.update({ where: { id: invoice.id }, data: { pdfPath: relPath } });
  }
}

export type MonthlyInvoiceInput = {
  date: Date;                // invoice issue date
  dueDate: Date;             // payment due date
  hours: number;
  hourlyRateCents?: number;  // optional override
  description?: string;
  clientId?: string;
  vatRate?: number;          // fraction override; defaults to the client's
  irpfRate?: number;         // fraction override; defaults to the client's
  bankAccountId?: string | null; // defaults to the client treatment's account
};

export type InvoiceLineInput = {
  description: string;
  quantity: number;
  unit?: string;
  unitPriceCents: number;
  vatRate?: number;          // fraction; falls back to the invoice-level rate
};

export type CreateInvoiceInput = {
  date: Date;
  dueDate: Date;
  clientId?: string;         // defaults to Settings.defaultClientId
  lines: InvoiceLineInput[];
  vatRate?: number;          // default VAT rate for lines that don't carry one
  irpfRate?: number;
  notes?: string;
  // Payment destination. Omitted (or null) picks the account whose rules claim
  // the client's tax treatment — see resolveBankAccountId.
  bankAccountId?: string | null;
};

// Services to a non-EU business are outside the scope of Spanish VAT under the
// place-of-supply rule, not exempt under art. 25 — so they need their own note
// rather than the intra-EU one configured in Settings.
export const EXPORT_EXEMPTION_NOTE =
  "Servicio no sujeto a IVA español por aplicación de las reglas de localización " +
  "(art. 69 y 70 de la Ley 37/1992). Not subject to Spanish VAT.";

// Tax treatment for a new invoice. The Client row is authoritative — the
// Settings defaults only seed the client form in the UI. Explicit overrides
// (from the invoice form or the bot) always win.
export function resolveInvoiceTax(
  client: Pick<Client, "vatTreatment" | "defaultVatRate" | "irpfRetentionRate" | "invoiceLocale">,
  settings: Pick<Settings, "vatExemptionFootnote">,
  overrides: { vatRate?: number; irpfRate?: number } = {}
): {
  vatTreatment: VatTreatment;
  vatRate: number;
  irpfRate: number;
  locale: string;
  vatExempt: boolean;
  exemptionNote: string | null;
} {
  const domestic = client.vatTreatment === "DOMESTIC_ES";
  const vatRate = overrides.vatRate ?? (domestic ? client.defaultVatRate : 0);
  const irpfRate = overrides.irpfRate ?? (domestic ? client.irpfRetentionRate : 0);
  const vatExempt = !domestic;
  return {
    vatTreatment: client.vatTreatment,
    vatRate,
    irpfRate,
    locale: client.invoiceLocale,
    vatExempt,
    exemptionNote: !vatExempt
      ? null
      : client.vatTreatment === "EXPORT_NON_EU"
        ? EXPORT_EXEMPTION_NOTE
        : settings.vatExemptionFootnote,
  };
}

export function formatInvoiceNumber(year: number, seq: number): string {
  return `FACT-${year}-${String(seq).padStart(5, "0")}`;
}

const INVOICE_NUMBER_RE = /^FACT-(\d{4})-(\d{5})$/;

// Inspect the DB and return the next FACT-{year}-NNNNN sequence to use for
// the given year (defaults to the current year). Robust against the settings
// counter being out of sync after bulk imports or historical replays — the
// source of truth is the actual max invoice number on disk PLUS the
// settings.invoiceNumberSeq high-water mark (so deleting the latest invoice
// doesn't cause its number to be reused).
export async function previewNextInvoiceNumber(year?: number): Promise<{
  year: number;
  seq: number;
  number: string;
}> {
  const targetYear = year ?? new Date().getUTCFullYear();
  const rows = await prisma.invoice.findMany({
    where: { number: { startsWith: `FACT-${targetYear}-` } },
    select: { number: true },
  });
  let maxSeq = 0;
  for (const r of rows) {
    const m = INVOICE_NUMBER_RE.exec(r.number);
    if (!m) continue;
    if (Number(m[1]) !== targetYear) continue;
    const seq = Number(m[2]);
    if (seq > maxSeq) maxSeq = seq;
  }
  // Respect the settings high-water mark for this year — prevents reuse after
  // delete. e.g. if settings says (year, seq=13) and only 1..11 exist on
  // disk because 12 was deleted, next is still 13.
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (settings && settings.invoiceNumberYear === targetYear) {
    maxSeq = Math.max(maxSeq, settings.invoiceNumberSeq - 1);
  }
  const seq = maxSeq + 1;
  return { year: targetYear, seq, number: formatInvoiceNumber(targetYear, seq) };
}

// Claim the next number atomically by reading the current max + 1 and
// writing the result back to settings (so the counter reflects reality
// post-claim). Also keeps settings.invoiceNumberYear/Seq in sync as a
// secondary record.
export async function claimNextInvoiceNumber(year?: number): Promise<{
  year: number;
  seq: number;
  number: string;
}> {
  const next = await previewNextInvoiceNumber(year);
  await prisma.settings.update({
    where: { id: 1 },
    data: { invoiceNumberYear: next.year, invoiceNumberSeq: next.seq + 1 },
  });
  return next;
}

// Last day of the month at UTC noon (avoids TZ edge cases on display).
export function lastDayOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0, 12, 0, 0));
}

export function firstDayOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1, 12, 0, 0));
}

export function addDays(d: Date, days: number): Date {
  const c = new Date(d.getTime());
  c.setUTCDate(c.getUTCDate() + days);
  return c;
}

// Create an invoice with an arbitrary number of lines. VAT and IRPF come from
// the client's tax treatment unless explicitly overridden.
export async function createInvoice(
  input: CreateInvoiceInput
): Promise<{ id: string; number: string }> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) throw new Error("Settings missing — run db:seed");

  const clientId = input.clientId ?? settings.defaultClientId;
  if (!clientId) {
    throw new Error(
      "No clientId given and Settings.defaultClientId is not set. " +
        "Open /settings or update prisma/seed.config.json and re-run db:seed."
    );
  }
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) throw new Error(`Client ${clientId} not found`);
  if (input.lines.length === 0) throw new Error("An invoice needs at least one line");

  const tax = resolveInvoiceTax(client, settings, {
    vatRate: input.vatRate,
    irpfRate: input.irpfRate,
  });
  const lines = input.lines.map((l, i) => ({
    position: i + 1,
    description: l.description,
    quantity: l.quantity,
    unit: l.unit ?? "h",
    unitPriceCents: l.unitPriceCents,
    vatRate: l.vatRate ?? tax.vatRate,
    netCents: lineNetCents(l),
  }));
  const totals = computeInvoiceTotals(lines, tax.irpfRate);

  // Resolved once, here, and then stored: re-pointing a default later must
  // never rewrite the payment details of an invoice already sent out.
  const bankAccountId = await resolveBankAccountId(tax.vatTreatment, input.bankAccountId);

  const { number } = await claimNextInvoiceNumber(input.date.getUTCFullYear());

  const created = await prisma.invoice.create({
    data: {
      number,
      date: input.date,
      dueDate: input.dueDate,
      clientId: client.id,
      subtotalCents: totals.subtotalCents,
      vatCents: totals.vatCents,
      irpfCents: totals.irpfCents,
      totalCents: totals.totalCents,
      currency: "EUR",
      vatExempt: tax.vatExempt,
      exemptionNote: tax.exemptionNote,
      vatTreatment: tax.vatTreatment,
      irpfRate: tax.irpfRate,
      locale: tax.locale,
      notes: input.notes,
      bankAccountId,
      lines: { create: lines },
    },
    select: { id: true, number: true },
  });
  // Render + persist the PDF to disk so the file exists for future downloads,
  // backups, and migrations. Don't fail the create if PDF write fails.
  try {
    await persistInvoicePdf(created.id);
  } catch (err) {
    console.error(`[invoice] PDF persist failed for ${created.id}:`, err);
  }
  return created;
}

// Convenience wrapper for the monthly hours × rate billing pattern — used by
// the Telegram agent and the historical import.
export async function createMonthlyInvoice(
  input: MonthlyInvoiceInput
): Promise<{ id: string; number: string }> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) throw new Error("Settings missing — run db:seed");
  return createInvoice({
    date: input.date,
    dueDate: input.dueDate,
    clientId: input.clientId,
    vatRate: input.vatRate,
    irpfRate: input.irpfRate,
    bankAccountId: input.bankAccountId,
    lines: [
      {
        description: input.description ?? settings.defaultLineDescription,
        quantity: input.hours,
        unit: "h",
        unitPriceCents: input.hourlyRateCents ?? settings.defaultHourlyRateCents,
      },
    ],
  });
}

export type UpdateInvoiceArgs = {
  id: string;
  date?: Date;
  dueDate?: Date;
  // Single-line shorthand (the monthly billing pattern the bot speaks). Applies
  // to the first line only. Ignored when `lines` is given.
  hours?: number;
  hourlyRateCents?: number;
  description?: string;
  clientId?: string;
  // Full replacement of the invoice's lines (the web editor).
  lines?: InvoiceLineInput[];
  vatRate?: number;
  irpfRate?: number;
  notes?: string;
  // undefined leaves the invoice's account alone; null re-resolves it from the
  // (possibly new) client treatment; an id pins that account.
  bankAccountId?: string | null;
};

export class InvoiceLockedError extends Error {
  constructor(public invoiceNumber: string, public reason: string) {
    super(`Invoice ${invoiceNumber} is locked: ${reason}`);
    this.name = "InvoiceLockedError";
  }
}

export async function updateInvoice(args: UpdateInvoiceArgs): Promise<{ id: string; number: string }> {
  const { isInvoiceLocked, invoiceLockState, lockReasonText } = await import("./invoice-lock");
  const existing = await prisma.invoice.findUnique({
    where: { id: args.id },
    include: { lines: { orderBy: { position: "asc" } } },
  });
  if (!existing) throw new Error(`Invoice ${args.id} not found`);
  if (isInvoiceLocked(existing)) {
    const reason = lockReasonText(invoiceLockState(existing)) ?? "locked";
    throw new InvoiceLockedError(existing.number, reason);
  }
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) throw new Error("Settings missing");

  const newDate = args.date ?? existing.date;
  const newDueDate = args.dueDate ?? existing.dueDate;
  const newClientId = args.clientId ?? existing.clientId;

  // Re-resolve the tax treatment from the client whenever the invoice moves to
  // a different one; otherwise keep the snapshot taken at issue time and only
  // apply explicit overrides.
  const clientChanged = newClientId !== existing.clientId;
  let tax: ReturnType<typeof resolveInvoiceTax>;
  if (clientChanged || args.vatRate != null || args.irpfRate != null) {
    const client = await prisma.client.findUnique({ where: { id: newClientId } });
    if (!client) throw new Error(`Client ${newClientId} not found`);
    tax = resolveInvoiceTax(
      clientChanged
        ? client
        : {
            // Same client: preserve the invoice's own snapshot as the baseline
            // so a since-edited Client row can't silently rewrite this invoice.
            vatTreatment: existing.vatTreatment,
            defaultVatRate: existing.lines[0]?.vatRate ?? 0,
            irpfRetentionRate: existing.irpfRate,
            invoiceLocale: existing.locale,
          },
      settings,
      { vatRate: args.vatRate, irpfRate: args.irpfRate }
    );
  } else {
    tax = {
      vatTreatment: existing.vatTreatment,
      vatRate: existing.lines[0]?.vatRate ?? 0,
      irpfRate: existing.irpfRate,
      locale: existing.locale,
      vatExempt: existing.vatExempt,
      exemptionNote: existing.exemptionNote,
    };
  }

  // Either replace every line (web editor) or patch the first line in place
  // (the bot's hours/rate/description shorthand). Moving the invoice to a
  // different client re-rates every line — an invoice can't mix treatments, so
  // an exempt line must not survive a move to a Spanish client.
  const lineVatRate = (current: number): number =>
    args.vatRate ?? (clientChanged ? tax.vatRate : current);
  const lineInputs: InvoiceLineInput[] =
    args.lines ??
    (() => {
      const first = existing.lines[0];
      const patched: InvoiceLineInput = {
        description: args.description ?? first?.description ?? settings.defaultLineDescription,
        quantity: args.hours ?? first?.quantity ?? 0,
        unit: first?.unit ?? "h",
        unitPriceCents:
          args.hourlyRateCents ?? first?.unitPriceCents ?? settings.defaultHourlyRateCents,
        vatRate: lineVatRate(first?.vatRate ?? tax.vatRate),
      };
      const rest: InvoiceLineInput[] = existing.lines.slice(1).map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        unitPriceCents: l.unitPriceCents,
        vatRate: lineVatRate(l.vatRate),
      }));
      return [patched, ...rest];
    })();

  if (lineInputs.length === 0) throw new Error("An invoice needs at least one line");

  // Moving the invoice to a client with a different treatment re-resolves the
  // payment account too, so a factura for a Spanish client can't keep pointing
  // at the account reserved for foreign ones.
  const bankAccountId =
    args.bankAccountId !== undefined
      ? await resolveBankAccountId(tax.vatTreatment, args.bankAccountId)
      : clientChanged
        ? await resolveBankAccountId(tax.vatTreatment)
        : existing.bankAccountId;

  const newLines = lineInputs.map((l, i) => ({
    position: i + 1,
    description: l.description,
    quantity: l.quantity,
    unit: l.unit ?? "h",
    unitPriceCents: l.unitPriceCents,
    vatRate: l.vatRate ?? tax.vatRate,
    netCents: lineNetCents(l),
  }));
  const totals = computeInvoiceTotals(newLines, tax.irpfRate);

  const updated = await prisma.invoice.update({
    where: { id: args.id },
    data: {
      date: newDate,
      dueDate: newDueDate,
      clientId: newClientId,
      subtotalCents: totals.subtotalCents,
      vatCents: totals.vatCents,
      irpfCents: totals.irpfCents,
      totalCents: totals.totalCents,
      vatExempt: tax.vatExempt,
      exemptionNote: tax.exemptionNote,
      vatTreatment: tax.vatTreatment,
      irpfRate: tax.irpfRate,
      locale: tax.locale,
      bankAccountId,
      ...(args.notes !== undefined ? { notes: args.notes } : {}),
      // Wholesale replace — simplest way to support added/removed rows while
      // keeping positions contiguous.
      lines: { deleteMany: {}, create: newLines },
    },
    select: { id: true, number: true },
  });
  // Re-render the PDF so it reflects the edited content.
  try {
    await persistInvoicePdf(updated.id);
  } catch (err) {
    console.error(`[invoice] PDF re-persist failed for ${updated.id}:`, err);
  }
  return updated;
}

export async function deleteInvoice(id: string): Promise<void> {
  const { isInvoiceLocked, invoiceLockState, lockReasonText } = await import("./invoice-lock");
  const existing = await prisma.invoice.findUnique({ where: { id } });
  if (!existing) throw new Error(`Invoice ${id} not found`);
  if (isInvoiceLocked(existing)) {
    const reason = lockReasonText(invoiceLockState(existing)) ?? "locked";
    throw new InvoiceLockedError(existing.number, reason);
  }
  await prisma.invoice.delete({ where: { id } });
  // Best-effort unlink — fine if the file never existed.
  if (existing.pdfPath) {
    const abs = path.resolve(UPLOAD_DIR, existing.pdfPath);
    const root = path.resolve(UPLOAD_DIR);
    if (abs.startsWith(root + path.sep)) {
      await fs.unlink(abs).catch(() => {});
    }
  }
}

export async function lockInvoice(id: string): Promise<{ lockedAt: Date }> {
  const updated = await prisma.invoice.update({
    where: { id },
    data: { lockedAt: new Date() },
    select: { lockedAt: true },
  });
  return { lockedAt: updated.lockedAt! };
}
