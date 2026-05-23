// Invoice lock policy.
//
// Legal rule: once an invoice's quarter has been filed at AEAT, the invoice
// is locked and can only be amended via a factura rectificativa. We
// approximate "filed" with the MOD 303 filing deadline of the invoice's
// quarter — 20 days after the quarter ends (Jan 30 for Q4).
//
// On top of that, the user can manually lock an invoice early by setting
// `invoice.lockedAt` (e.g., once they've sent the PDF to the client).

import { quarterOf } from "./tax";

export type LockState =
  | { locked: false }
  | { locked: true; reason: "manual"; lockedAt: Date }
  | { locked: true; reason: "filing_deadline"; deadline: Date };

// First day on which the invoice's quarter is considered filed (= one day
// after the MOD 303 deadline of that quarter).
export function legalLockDate(invoiceDate: Date): Date {
  const q = quarterOf(invoiceDate);
  const year = invoiceDate.getUTCFullYear();
  if (q === 4) {
    // Q4 due Jan 30 → locked from Jan 31 next year.
    return new Date(Date.UTC(year + 1, 0, 31));
  }
  // Q1/Q2/Q3 due 20th of month after quarter → locked from 21st.
  return new Date(Date.UTC(year, q * 3, 21));
}

export function invoiceLockState(invoice: {
  date: Date;
  lockedAt: Date | null;
}): LockState {
  if (invoice.lockedAt) {
    return { locked: true, reason: "manual", lockedAt: invoice.lockedAt };
  }
  const deadline = legalLockDate(invoice.date);
  if (Date.now() >= deadline.getTime()) {
    return { locked: true, reason: "filing_deadline", deadline };
  }
  return { locked: false };
}

export function isInvoiceLocked(invoice: {
  date: Date;
  lockedAt: Date | null;
}): boolean {
  return invoiceLockState(invoice).locked;
}

export function lockReasonText(state: LockState): string | null {
  if (!state.locked) return null;
  if (state.reason === "manual") {
    return `Marked final on ${state.lockedAt.toISOString().slice(0, 10)}.`;
  }
  return (
    `Past MOD 303 filing deadline (${state.deadline.toISOString().slice(0, 10)}). ` +
    `Amendments must be issued as a factura rectificativa, not by editing.`
  );
}
