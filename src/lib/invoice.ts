import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "./db";

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
      include: { lines: { orderBy: { position: "asc" } }, client: true },
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
};

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

export async function createMonthlyInvoice(
  input: MonthlyInvoiceInput
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

  const description = input.description ?? settings.defaultLineDescription;
  const unitPriceCents = input.hourlyRateCents ?? settings.defaultHourlyRateCents;
  // Round to cents to avoid float drift on multiplication.
  const netCents = Math.round(input.hours * unitPriceCents);
  const vatCents = 0; // intra-EU reverse charge for our scenario

  const date = input.date;
  const dueDate = input.dueDate;
  const { number } = await claimNextInvoiceNumber(date.getUTCFullYear());

  const created = await prisma.invoice.create({
    data: {
      number,
      date,
      dueDate,
      clientId: client.id,
      subtotalCents: netCents,
      vatCents,
      totalCents: netCents + vatCents,
      currency: "EUR",
      vatExempt: true,
      exemptionNote: settings.vatExemptionFootnote,
      lines: {
        create: [
          {
            position: 1,
            description,
            quantity: input.hours,
            unit: "h",
            unitPriceCents,
            vatRate: 0,
            netCents,
          },
        ],
      },
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

export type UpdateInvoiceArgs = {
  id: string;
  date?: Date;
  dueDate?: Date;
  hours?: number;
  hourlyRateCents?: number;
  description?: string;
  clientId?: string;
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
  // We currently support invoices with a single line (the monthly billing
  // pattern). Editing replaces that line's quantity / unitPrice / description.
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) throw new Error("Settings missing");

  const newDate = args.date ?? existing.date;
  const newDueDate = args.dueDate ?? existing.dueDate;
  const newClientId = args.clientId ?? existing.clientId;

  const line = existing.lines[0];
  const newHours = args.hours ?? (line?.quantity ?? 0);
  const newUnit = args.hourlyRateCents ?? (line?.unitPriceCents ?? settings.defaultHourlyRateCents);
  const newDesc = args.description ?? (line?.description ?? settings.defaultLineDescription);
  const newNetCents = Math.round(newHours * newUnit);

  const updated = await prisma.invoice.update({
    where: { id: args.id },
    data: {
      date: newDate,
      dueDate: newDueDate,
      clientId: newClientId,
      subtotalCents: newNetCents,
      totalCents: newNetCents + existing.vatCents,
      lines: line
        ? {
            update: {
              where: { id: line.id },
              data: {
                quantity: newHours,
                unitPriceCents: newUnit,
                description: newDesc,
                netCents: newNetCents,
              },
            },
          }
        : undefined,
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
