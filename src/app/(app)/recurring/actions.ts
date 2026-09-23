"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { RecurringFrequency } from "@prisma/client";
import { prisma } from "@/lib/db";
import { parseInvoiceFormLines, parseInvoiceFormDate, parseRatePct } from "@/lib/invoice-form";
import { serializeTemplateLines, periodKeyOf, issueAndSendRecurringRun } from "@/lib/recurring";
import { looksLikeEmail, parseRecipients } from "@/lib/email";

const FREQUENCIES = new Set<RecurringFrequency>(["MONTHLY", "QUARTERLY", "YEARLY"]);

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function optional(formData: FormData, key: string): string | null {
  const v = str(formData, key);
  return v.length > 0 ? v : null;
}

function intInRange(formData: FormData, key: string, lo: number, hi: number, fallback: number): number {
  const n = Number(formData.get(key));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

// Recipient overrides are free text; reject typos here rather than discovering
// them when the cron tries to send.
function recipients(formData: FormData, key: string): string | null {
  const raw = optional(formData, key);
  if (!raw) return null;
  const list = parseRecipients(raw);
  const bad = list.filter((a) => !looksLikeEmail(a));
  if (bad.length > 0) throw new Error(`Not a valid email address: ${bad.join(", ")}`);
  return list.join(", ");
}

function readForm(formData: FormData) {
  const name = str(formData, "name");
  if (!name) throw new Error("Name is required");
  const clientId = str(formData, "clientId");
  if (!clientId) throw new Error("Pick a client");

  const startDate = parseInvoiceFormDate(str(formData, "startDate"));
  if (!startDate) throw new Error("First invoice date is required (YYYY-MM-DD)");
  const endRaw = optional(formData, "endDate");
  const endDate = endRaw ? parseInvoiceFormDate(endRaw) : null;
  if (endRaw && !endDate) throw new Error("Stop-after date must be YYYY-MM-DD");
  if (endDate && endDate.getTime() < startDate.getTime()) {
    throw new Error("Stop-after date is before the first invoice date");
  }

  const frequencyRaw = str(formData, "frequency") as RecurringFrequency;
  const frequency: RecurringFrequency = FREQUENCIES.has(frequencyRaw) ? frequencyRaw : "MONTHLY";

  const lines = parseInvoiceFormLines(formData.get("lines"));
  const irpfRate = parseRatePct(formData.get("irpfRatePct"));

  return {
    name,
    clientId,
    active: formData.get("active") != null,
    frequency,
    dayOfMonth: intInRange(formData, "dayOfMonth", 1, 31, 1),
    dueDays: intInRange(formData, "dueDays", 0, 365, 15),
    startDate,
    endDate,
    linesJson: serializeTemplateLines(lines),
    // Lines carry their own VAT rate, so only the retention needs storing at
    // schedule level — it applies to the invoice as a whole.
    vatRate: null,
    irpfRate: irpfRate > 0 ? irpfRate : null,
    notes: optional(formData, "notes"),
    emailTo: recipients(formData, "emailTo"),
    emailCc: recipients(formData, "emailCc"),
    // Empty means automatic — the account is then resolved from the client's
    // treatment each time this schedule issues an invoice.
    bankAccountId: optional(formData, "bankAccountId"),
  };
}

export async function createRecurring(formData: FormData): Promise<void> {
  const data = readForm(formData);
  await prisma.recurringInvoice.create({ data });
  revalidatePath("/recurring");
  redirect("/recurring");
}

export async function updateRecurring(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  if (!id) throw new Error("Missing schedule id");
  const data = readForm(formData);
  await prisma.recurringInvoice.update({ where: { id }, data });
  revalidatePath("/recurring");
  redirect("/recurring");
}

export async function deleteRecurring(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  if (!id) throw new Error("Missing schedule id");
  // Invoices already issued from this schedule are untouched — the run rows
  // cascade away, the invoices they point at do not.
  await prisma.recurringInvoice.delete({ where: { id } });
  revalidatePath("/recurring");
  redirect("/recurring");
}

export async function toggleRecurring(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  if (!id) throw new Error("Missing schedule id");
  const existing = await prisma.recurringInvoice.findUnique({
    where: { id },
    select: { active: true },
  });
  if (!existing) throw new Error("Schedule not found");
  await prisma.recurringInvoice.update({ where: { id }, data: { active: !existing.active } });
  revalidatePath("/recurring");
}

// Bill this period right now instead of waiting for the cron — issues the
// invoice and emails it in one step. Keyed by the current period so it can't
// double-bill a month the cron already handled.
export async function issueRecurringNow(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  if (!id) throw new Error("Missing schedule id");
  const schedule = await prisma.recurringInvoice.findUnique({ where: { id } });
  if (!schedule) throw new Error("Schedule not found");

  const now = new Date();
  const periodKey = periodKeyOf(now);
  const existing = await prisma.recurringRun.findUnique({
    where: { recurringInvoiceId_periodKey: { recurringInvoiceId: id, periodKey } },
  });
  if (existing && existing.status !== "PENDING_CONFIRMATION") {
    throw new Error(
      `${schedule.name} was already billed for ${periodKey} (${existing.status.toLowerCase()}).`
    );
  }
  const run =
    existing ??
    (await prisma.recurringRun.create({
      data: { recurringInvoiceId: id, periodKey, dueOn: now },
    }));

  const result = await issueAndSendRecurringRun(run.id);
  revalidatePath("/recurring");
  revalidatePath("/invoices");
  if (!result.emailed) {
    throw new Error(
      `Invoice ${result.number} was issued but the email failed: ${result.emailError ?? "SMTP not configured"}`
    );
  }
  redirect(`/invoices/${result.invoiceId}`);
}
