// Mutation primitives — the *actual* update/delete logic, separated from
// tool definitions so the bot worker's callback handler can call them after
// the user taps Apply on a confirmation card.
//
// Tools in tools.ts MUST NOT call these directly; they create pending
// actions instead. Only the callback handler in scripts/bot-poll.ts can.

import { prisma } from "../db";
import { applyDeduction, defaultDeductiblePct } from "../deduction";
import {
  updateInvoice as updateInvoiceCore,
  deleteInvoice as deleteInvoiceCore,
  InvoiceLockedError,
  type UpdateInvoiceArgs as InvoiceUpdateCore,
} from "../invoice";
import { invoiceLockState, lockReasonText } from "../invoice-lock";

export type UpdateExpenseArgs = {
  id: string;
  category?: string;
  deductiblePct?: number;
  vendor?: string;
  notes?: string;
  date?: string;        // YYYY-MM-DD
  grossEur?: number;
  netEur?: number;
  vatEur?: number;
  vatRate?: number;
  confirm?: boolean;
};

export async function executeUpdateExpense(
  args: UpdateExpenseArgs
): Promise<{ id: string }> {
  const existing = await prisma.expense.findUnique({ where: { id: args.id } });
  if (!existing) throw new Error(`Expense ${args.id} not found`);
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) throw new Error("Settings missing");

  const newCategory = (args.category ?? existing.category) as typeof existing.category;
  const newDate =
    args.date != null
      ? new Date(
          Date.UTC(
            Number(args.date.slice(0, 4)),
            Number(args.date.slice(5, 7)) - 1,
            Number(args.date.slice(8, 10)),
            12
          )
        )
      : existing.date;

  let newGross = existing.grossCents;
  let newNet = existing.netCents;
  let newVat = existing.vatCents;
  const newVatRate = args.vatRate ?? existing.vatRate;

  if (args.grossEur != null) newGross = Math.round(args.grossEur * 100);
  if (args.netEur != null) newNet = Math.round(args.netEur * 100);
  if (args.vatEur != null) newVat = Math.round(args.vatEur * 100);

  if (args.grossEur != null && args.netEur == null && args.vatEur == null) {
    newNet = Math.round(newGross / (1 + newVatRate));
    newVat = newGross - newNet;
  } else if (args.netEur != null && args.vatEur == null && args.grossEur == null) {
    newVat = Math.round(newNet * newVatRate);
    newGross = newNet + newVat;
  } else if (args.grossEur != null || args.netEur != null || args.vatEur != null) {
    if (args.vatEur != null && args.netEur == null && args.grossEur == null) {
      newNet = Math.max(0, newGross - newVat);
    }
    if (args.grossEur == null) newGross = newNet + newVat;
  }

  const newPct =
    args.deductiblePct != null
      ? args.deductiblePct
      : args.category != null
        ? defaultDeductiblePct(newCategory, settings, newDate)
        : existing.deductiblePct;
  const ded = applyDeduction(newPct, newNet, newVat);

  const updated = await prisma.expense.update({
    where: { id: args.id },
    data: {
      category: newCategory,
      date: newDate,
      vendor: args.vendor ?? existing.vendor,
      notes: args.notes ?? existing.notes,
      grossCents: newGross,
      netCents: newNet,
      vatCents: newVat,
      vatRate: newVatRate,
      deductiblePct: newPct,
      deductibleNetCents: ded.deductibleNetCents,
      deductibleVatCents: ded.deductibleVatCents,
      status: args.confirm ? "CONFIRMED" : existing.status,
    },
  });
  return { id: updated.id };
}

export async function executeDeleteExpense(id: string): Promise<{ deleted: string }> {
  await prisma.expense.delete({ where: { id } });
  return { deleted: id };
}

// Build a human-readable summary of what an update would change. Used in the
// confirmation message body so the user sees a diff before tapping Apply.
export async function describeUpdateExpense(args: UpdateExpenseArgs): Promise<{
  summary: string;
  vendor: string;
  expenseId: string;
}> {
  const existing = await prisma.expense.findUnique({ where: { id: args.id } });
  if (!existing) throw new Error(`Expense ${args.id} not found`);
  const lines: string[] = [];
  const eur = (c: number) => (c / 100).toFixed(2);
  if (args.date != null && args.date !== existing.date.toISOString().slice(0, 10)) {
    lines.push(`date: ${existing.date.toISOString().slice(0, 10)} → <b>${args.date}</b>`);
  }
  if (args.vendor != null && args.vendor !== existing.vendor) {
    lines.push(`vendor: ${escHtml(existing.vendor)} → <b>${escHtml(args.vendor)}</b>`);
  }
  if (args.category != null && args.category !== existing.category) {
    lines.push(`category: ${existing.category} → <b>${args.category}</b>`);
  }
  if (args.grossEur != null) {
    const nc = Math.round(args.grossEur * 100);
    if (nc !== existing.grossCents) {
      lines.push(`gross: €${eur(existing.grossCents)} → <b>€${eur(nc)}</b>`);
    }
  }
  if (args.netEur != null) {
    const nc = Math.round(args.netEur * 100);
    if (nc !== existing.netCents) {
      lines.push(`net: €${eur(existing.netCents)} → <b>€${eur(nc)}</b>`);
    }
  }
  if (args.vatEur != null) {
    const nc = Math.round(args.vatEur * 100);
    if (nc !== existing.vatCents) {
      lines.push(`VAT: €${eur(existing.vatCents)} → <b>€${eur(nc)}</b>`);
    }
  }
  if (args.vatRate != null && args.vatRate !== existing.vatRate) {
    lines.push(`VAT rate: ${existing.vatRate} → <b>${args.vatRate}</b>`);
  }
  if (args.deductiblePct != null && args.deductiblePct !== existing.deductiblePct) {
    lines.push(`deductible %: ${existing.deductiblePct} → <b>${args.deductiblePct}</b>`);
  }
  if (args.notes != null && args.notes !== existing.notes) {
    lines.push(`notes: <i>changed</i>`);
  }
  if (args.confirm) {
    lines.push(`status: ${existing.status} → <b>CONFIRMED</b>`);
  }
  if (lines.length === 0) lines.push("<i>(no field changes)</i>");
  const summary =
    `<b>Proposed update</b> to expense <code>${existing.id}</code>\n` +
    `<i>${escHtml(existing.vendor)} · ${existing.date.toISOString().slice(0, 10)} · €${eur(existing.grossCents)}</i>\n` +
    "\n" +
    lines.join("\n");
  return { summary, vendor: existing.vendor, expenseId: existing.id };
}

export async function describeDeleteExpense(id: string): Promise<{ summary: string }> {
  const existing = await prisma.expense.findUnique({ where: { id } });
  if (!existing) throw new Error(`Expense ${id} not found`);
  const eur = (c: number) => (c / 100).toFixed(2);
  const summary =
    `<b>🗑️ Proposed delete</b>\n` +
    `<i>${escHtml(existing.vendor)} · ${existing.date.toISOString().slice(0, 10)} · €${eur(existing.grossCents)}</i>\n` +
    `Category: <code>${existing.category}</code>\n` +
    `Deductible was: €${eur(existing.deductibleNetCents + existing.deductibleVatCents)}\n\n` +
    `<i>This permanently removes the entry from the books.</i>`;
  return { summary };
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// -------- Invoices --------

export type UpdateInvoiceAgentArgs = {
  id: string;
  date?: string;        // YYYY-MM-DD
  dueDate?: string;     // YYYY-MM-DD
  hours?: number;
  hourlyRateEur?: number;
  description?: string;
  clientId?: string;
};

function parseInvoiceArgs(args: UpdateInvoiceAgentArgs): InvoiceUpdateCore {
  const parseDate = (s: string): Date => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) throw new Error(`Invalid date: ${s}`);
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  };
  return {
    id: args.id,
    date: args.date ? parseDate(args.date) : undefined,
    dueDate: args.dueDate ? parseDate(args.dueDate) : undefined,
    hours: args.hours,
    hourlyRateCents:
      args.hourlyRateEur != null ? Math.round(args.hourlyRateEur * 100) : undefined,
    description: args.description,
    clientId: args.clientId,
  };
}

export async function executeUpdateInvoice(
  args: UpdateInvoiceAgentArgs
): Promise<{ id: string; number: string }> {
  return updateInvoiceCore(parseInvoiceArgs(args));
}

export async function executeDeleteInvoice(id: string): Promise<{ deleted: string }> {
  await deleteInvoiceCore(id);
  return { deleted: id };
}

export async function describeUpdateInvoice(args: UpdateInvoiceAgentArgs): Promise<{
  summary: string;
  invoiceNumber: string;
  locked: boolean;
  lockReason: string | null;
}> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: args.id },
    include: { lines: { orderBy: { position: "asc" } }, client: true },
  });
  if (!invoice) throw new Error(`Invoice ${args.id} not found`);
  const state = invoiceLockState(invoice);
  const locked = state.locked;
  const lockReason = lockReasonText(state);
  const line = invoice.lines[0];
  const lines: string[] = [];
  const eur = (c: number) => (c / 100).toFixed(2);
  const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

  if (args.date && args.date !== fmtDate(invoice.date)) {
    lines.push(`date: ${fmtDate(invoice.date)} → <b>${args.date}</b>`);
  }
  if (args.dueDate && args.dueDate !== fmtDate(invoice.dueDate)) {
    lines.push(`due date: ${fmtDate(invoice.dueDate)} → <b>${args.dueDate}</b>`);
  }
  if (args.hours != null && line && args.hours !== line.quantity) {
    lines.push(`hours: ${line.quantity} → <b>${args.hours}</b>`);
  }
  if (args.hourlyRateEur != null && line) {
    const nc = Math.round(args.hourlyRateEur * 100);
    if (nc !== line.unitPriceCents) {
      lines.push(`rate: €${eur(line.unitPriceCents)} → <b>€${eur(nc)}</b>/h`);
    }
  }
  if (args.description != null && line && args.description !== line.description) {
    lines.push(`description: <i>changed</i>`);
  }
  if (args.clientId && args.clientId !== invoice.clientId) {
    lines.push(`client: ${escHtml(invoice.client.name)} → <b>id ${escHtml(args.clientId)}</b>`);
  }
  if (lines.length === 0) lines.push("<i>(no field changes)</i>");

  const summary =
    `<b>Proposed update</b> to invoice <code>${invoice.number}</code>\n` +
    `<i>${fmtDate(invoice.date)} · ${escHtml(invoice.client.name)} · €${eur(invoice.totalCents)}</i>\n` +
    "\n" +
    lines.join("\n") +
    (locked ? `\n\n🔒 <b>Locked:</b> ${lockReason ?? "cannot amend"}` : "");
  return { summary, invoiceNumber: invoice.number, locked, lockReason };
}

export async function describeDeleteInvoice(id: string): Promise<{
  summary: string;
  locked: boolean;
  lockReason: string | null;
}> {
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: { client: true },
  });
  if (!invoice) throw new Error(`Invoice ${id} not found`);
  const state = invoiceLockState(invoice);
  const locked = state.locked;
  const lockReason = lockReasonText(state);
  const eur = (c: number) => (c / 100).toFixed(2);
  const summary =
    `<b>🗑️ Proposed delete</b>\n` +
    `<i>${invoice.number} · ${invoice.date.toISOString().slice(0, 10)} · ${escHtml(invoice.client.name)} · €${eur(invoice.totalCents)}</i>\n\n` +
    (locked
      ? `🔒 <b>Locked:</b> ${lockReason ?? "cannot delete"}`
      : `<i>This permanently removes the invoice. The FACT number will not be reused.</i>`);
  return { summary, locked, lockReason };
}

// Re-export so the bot worker can `import { InvoiceLockedError } from "./mutations"`.
export { InvoiceLockedError };
