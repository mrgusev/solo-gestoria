// Recurring invoices — standing instructions to bill a client on a schedule.
//
// Deliberately split in two halves: this module decides *when* an occurrence is
// due and what it would contain, and only `issueRecurringRun` writes an actual
// Invoice. The cron never issues on its own, because an invoice number is
// permanent — the FACT-YYYY-NNNNN series has to stay gapless (art. 6.1.a
// RD 1619/2012), so a "maybe" invoice that gets deleted on a skip would leave a
// hole an inspector can see. Instead the cron posts a preview and the numbered
// invoice is created at the moment the user confirms.

import type {
  BankAccount,
  Client,
  Invoice,
  InvoiceLine,
  RecurringFrequency,
  RecurringInvoice,
  RecurringRun,
} from "@prisma/client";
import { prisma } from "./db";
import { computeInvoiceTotals, lineNetCents, type InvoiceTotals } from "./invoice-totals";
import { listBankAccounts } from "./bank-accounts-db";
import { pickBankAccountFor } from "./bank-accounts";
import {
  createInvoice,
  previewNextInvoiceNumber,
  resolveInvoiceTax,
  type InvoiceLineInput,
} from "./invoice";

// How far back the cron will reach for an occurrence it never posted. Covers a
// long worker outage without carpet-bombing the user with a year of prompts
// when a schedule is created with a startDate well in the past.
export const BACKFILL_WINDOW_DAYS = 45;

export function monthsPerPeriod(frequency: RecurringFrequency): number {
  switch (frequency) {
    case "MONTHLY":
      return 1;
    case "QUARTERLY":
      return 3;
    case "YEARLY":
      return 12;
  }
}

export function frequencyLabel(frequency: RecurringFrequency): string {
  switch (frequency) {
    case "MONTHLY":
      return "Monthly";
    case "QUARTERLY":
      return "Every 3 months";
    case "YEARLY":
      return "Yearly";
  }
}

// "2026-08" — identifies one occurrence of one schedule. Month granularity is
// enough because no frequency we offer fires twice in a month.
export function periodKeyOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

// UTC noon, like every other date this app stores — keeps a date from sliding
// across a day boundary when it's rendered in a non-UTC zone.
function utcNoon(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day, 12, 0, 0));
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

export function addDaysUtc(d: Date, days: number): Date {
  const c = new Date(d.getTime());
  c.setUTCDate(c.getUTCDate() + days);
  return c;
}

type ScheduleTiming = Pick<
  RecurringInvoice,
  "frequency" | "dayOfMonth" | "startDate" | "endDate" | "dueDays"
>;

// The nth occurrence's issue date. Day 31 on a 30-day month lands on the 30th
// rather than spilling into the next one.
export function occurrenceDate(schedule: ScheduleTiming, index: number): Date {
  const start = schedule.startDate;
  const monthIndex = start.getUTCMonth() + index * monthsPerPeriod(schedule.frequency);
  const year = start.getUTCFullYear() + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  const day = Math.min(Math.max(schedule.dayOfMonth, 1), daysInMonth(year, month));
  return utcNoon(year, month, day);
}

export function dueDateFor(schedule: ScheduleTiming, issueDate: Date): Date {
  return addDaysUtc(issueDate, Math.max(0, schedule.dueDays));
}

// Every occurrence at or before `now`, newest last. Bounded by endDate and by
// the backfill window.
export function occurrencesUpTo(schedule: ScheduleTiming, now: Date): Date[] {
  const out: Date[] = [];
  const floor = addDaysUtc(now, -BACKFILL_WINDOW_DAYS);
  // Cap the walk so a corrupt startDate can't spin forever; 400 periods is
  // 33 years of monthly billing.
  for (let i = 0; i < 400; i++) {
    const date = occurrenceDate(schedule, i);
    if (date.getTime() > now.getTime()) break;
    if (schedule.endDate && date.getTime() > schedule.endDate.getTime()) break;
    if (date.getTime() >= floor.getTime()) out.push(date);
  }
  return out;
}

// The next occurrence strictly after `now`, or null once the schedule has run
// past its endDate. Drives the "next issue" column in the UI.
export function nextOccurrenceAfter(schedule: ScheduleTiming, now: Date): Date | null {
  for (let i = 0; i < 400; i++) {
    const date = occurrenceDate(schedule, i);
    if (date.getTime() <= now.getTime()) continue;
    if (schedule.endDate && date.getTime() > schedule.endDate.getTime()) return null;
    return date;
  }
  return null;
}

// ---- Template lines ----

// linesJson holds the same InvoiceLineInput[] the web editor and the bot build.
// Anything malformed is treated as an empty template, which the callers reject
// with a clear message rather than issuing a €0 invoice.
export function parseTemplateLines(linesJson: string): InvoiceLineInput[] {
  let raw: unknown;
  try {
    raw = JSON.parse(linesJson);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: InvoiceLineInput[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const l = item as Record<string, unknown>;
    const description = typeof l.description === "string" ? l.description : "";
    const quantity = Number(l.quantity);
    const unitPriceCents = Number(l.unitPriceCents);
    if (!description || !Number.isFinite(quantity) || !Number.isFinite(unitPriceCents)) continue;
    out.push({
      description,
      quantity,
      unit: typeof l.unit === "string" && l.unit.length > 0 ? l.unit : "h",
      unitPriceCents: Math.round(unitPriceCents),
      ...(Number.isFinite(Number(l.vatRate)) && l.vatRate != null
        ? { vatRate: Number(l.vatRate) }
        : {}),
    });
  }
  return out;
}

export function serializeTemplateLines(lines: InvoiceLineInput[]): string {
  return JSON.stringify(
    lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unit: l.unit ?? "h",
      unitPriceCents: l.unitPriceCents,
      ...(l.vatRate != null ? { vatRate: l.vatRate } : {}),
    }))
  );
}

// ---- Preview ----

export type RecurringPreview = {
  number: string;              // prospective — not claimed until the invoice is issued
  date: Date;
  dueDate: Date;
  locale: string;
  lines: (InvoiceLineInput & { netCents: number; vatRate: number })[];
  totals: InvoiceTotals;
  client: Client;
};

// What the invoice *would* look like, without touching the numbering counter.
export async function previewRecurring(
  schedule: RecurringInvoice & { client: Client },
  issueDate: Date
): Promise<RecurringPreview> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) throw new Error("Settings missing — run db:seed");
  const template = parseTemplateLines(schedule.linesJson);
  if (template.length === 0) {
    throw new Error(`Recurring schedule "${schedule.name}" has no usable template lines`);
  }
  const tax = resolveInvoiceTax(schedule.client, settings, {
    vatRate: schedule.vatRate ?? undefined,
    irpfRate: schedule.irpfRate ?? undefined,
  });
  const lines = template.map((l) => ({
    ...l,
    vatRate: l.vatRate ?? tax.vatRate,
    netCents: lineNetCents(l),
  }));
  const { number } = await previewNextInvoiceNumber(issueDate.getUTCFullYear());
  return {
    number,
    date: issueDate,
    dueDate: dueDateFor(schedule, issueDate),
    locale: tax.locale,
    lines,
    totals: computeInvoiceTotals(lines, tax.irpfRate),
    client: schedule.client,
  };
}

// Render the preview through the real PDF template by handing it an in-memory
// Invoice that is never persisted. The number shown is the one the invoice
// would get if confirmed right now.
export async function renderPreviewPdf(
  schedule: RecurringInvoice & { client: Client },
  issueDate: Date
): Promise<{ pdf: Buffer; preview: RecurringPreview }> {
  const [settings, preview, accounts] = await Promise.all([
    prisma.settings.findUnique({ where: { id: 1 } }),
    previewRecurring(schedule, issueDate),
    listBankAccounts({ includeArchived: true }),
  ]);
  if (!settings) throw new Error("Settings missing — run db:seed");
  const tax = resolveInvoiceTax(schedule.client, settings, {
    vatRate: schedule.vatRate ?? undefined,
    irpfRate: schedule.irpfRate ?? undefined,
  });
  // Same resolution issueRecurringRun will apply, so the preview PDF shows the
  // account the real invoice would carry.
  const bankAccount: BankAccount | null =
    accounts.find((a) => a.id === schedule.bankAccountId) ??
    pickBankAccountFor(accounts, tax.vatTreatment);
  const now = new Date();
  const invoice: Invoice & {
    lines: InvoiceLine[];
    client: Client;
    bankAccount: BankAccount | null;
  } = {
    id: `preview-${schedule.id}`,
    number: preview.number,
    date: preview.date,
    dueDate: preview.dueDate,
    clientId: schedule.clientId,
    subtotalCents: preview.totals.subtotalCents,
    vatCents: preview.totals.vatCents,
    irpfCents: preview.totals.irpfCents,
    totalCents: preview.totals.totalCents,
    currency: "EUR",
    vatExempt: tax.vatExempt,
    exemptionNote: tax.exemptionNote,
    vatTreatment: tax.vatTreatment,
    irpfRate: tax.irpfRate,
    locale: tax.locale,
    notes: schedule.notes,
    bankAccountId: bankAccount?.id ?? null,
    bankAccount,
    pdfPath: null,
    lockedAt: null,
    emailedAt: null,
    emailedTo: null,
    createdAt: now,
    updatedAt: now,
    client: schedule.client,
    lines: preview.lines.map((l, i) => ({
      id: `preview-line-${i}`,
      invoiceId: `preview-${schedule.id}`,
      position: i + 1,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit ?? "h",
      unitPriceCents: l.unitPriceCents,
      vatRate: l.vatRate,
      netCents: l.netCents,
    })),
  };
  const { renderInvoicePdf } = await import("./invoice-pdf");
  return { pdf: await renderInvoicePdf({ invoice, settings }), preview };
}

// ---- Cron ----

export type DueOccurrence = {
  schedule: RecurringInvoice & { client: Client };
  run: RecurringRun;
};

// Find every occurrence that is due and has no run row yet, and create those
// rows. Creating the row *is* the claim: the unique (schedule, period) index
// means a second tick — or a second worker — silently loses the race instead of
// billing twice. Returns only the rows this call created.
export async function claimDueOccurrences(now: Date = new Date()): Promise<DueOccurrence[]> {
  const schedules = await prisma.recurringInvoice.findMany({
    where: { active: true },
    include: { client: true },
  });
  const claimed: DueOccurrence[] = [];
  for (const schedule of schedules) {
    for (const date of occurrencesUpTo(schedule, now)) {
      const periodKey = periodKeyOf(date);
      try {
        const run = await prisma.recurringRun.create({
          data: { recurringInvoiceId: schedule.id, periodKey, dueOn: date },
        });
        claimed.push({ schedule, run });
      } catch {
        // Unique-constraint violation — this period was already handled.
      }
    }
  }
  return claimed;
}

// Turn a pending run into a real, numbered invoice. Safe to call twice: if the
// run already carries an invoice, that one is returned untouched.
export async function issueRecurringRun(
  runId: string
): Promise<{ invoiceId: string; number: string }> {
  const run = await prisma.recurringRun.findUnique({
    where: { id: runId },
    include: { recurring: { include: { client: true } } },
  });
  if (!run) throw new Error(`Recurring run ${runId} not found`);
  if (run.invoiceId) {
    const existing = await prisma.invoice.findUnique({
      where: { id: run.invoiceId },
      select: { id: true, number: true },
    });
    if (existing) return { invoiceId: existing.id, number: existing.number };
  }
  const schedule = run.recurring;
  const lines = parseTemplateLines(schedule.linesJson);
  if (lines.length === 0) {
    throw new Error(`Recurring schedule "${schedule.name}" has no usable template lines`);
  }
  const created = await createInvoice({
    date: run.dueOn,
    dueDate: dueDateFor(schedule, run.dueOn),
    clientId: schedule.clientId,
    lines,
    vatRate: schedule.vatRate ?? undefined,
    irpfRate: schedule.irpfRate ?? undefined,
    notes: schedule.notes ?? undefined,
    bankAccountId: schedule.bankAccountId,
  });
  await prisma.recurringRun.update({
    where: { id: run.id },
    data: { invoiceId: created.id, status: "ISSUED", error: null },
  });
  return { invoiceId: created.id, number: created.number };
}

// Issue + email in one step, which is what the Telegram "Issue & send" button
// does. A failing send still leaves the invoice issued (status ISSUED) — the
// number is spent either way, so hiding it would be worse than reporting it.
export async function issueAndSendRecurringRun(runId: string): Promise<{
  invoiceId: string;
  number: string;
  emailed: boolean;
  recipients: string[];
  emailError?: string;
}> {
  const run = await prisma.recurringRun.findUnique({
    where: { id: runId },
    include: { recurring: { include: { client: true } } },
  });
  if (!run) throw new Error(`Recurring run ${runId} not found`);
  const issued = await issueRecurringRun(runId);

  const { sendInvoiceEmail, parseRecipients } = await import("./email");
  const to = parseRecipients(run.recurring.emailTo ?? run.recurring.client.email);
  const cc = parseRecipients(run.recurring.emailCc);
  try {
    const sent = await sendInvoiceEmail({ invoiceId: issued.invoiceId, to, cc });
    await prisma.recurringRun.update({
      where: { id: run.id },
      data: { status: "SENT", resolvedAt: new Date(), error: null },
    });
    return { ...issued, emailed: true, recipients: [...sent.to, ...sent.cc] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.recurringRun.update({
      where: { id: run.id },
      data: { status: "ISSUED", resolvedAt: new Date(), error: message },
    });
    return { ...issued, emailed: false, recipients: to, emailError: message };
  }
}

export async function skipRecurringRun(runId: string): Promise<void> {
  await prisma.recurringRun.update({
    where: { id: runId },
    data: { status: "SKIPPED", resolvedAt: new Date() },
  });
}

export async function failRecurringRun(runId: string, error: string): Promise<void> {
  await prisma.recurringRun.update({
    where: { id: runId },
    data: { status: "FAILED", resolvedAt: new Date(), error },
  });
}

// Summary line used in both the Telegram prompt and the web list.
export function describeSchedule(
  schedule: Pick<RecurringInvoice, "frequency" | "dayOfMonth" | "dueDays">
): string {
  return `${frequencyLabel(schedule.frequency)} on day ${schedule.dayOfMonth}, due in ${schedule.dueDays} days`;
}
