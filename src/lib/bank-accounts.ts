// Payment destinations — the bank details an invoice tells the client to pay
// into. Client-side-safe by design (the invoice editor imports from here), so
// this module never imports prisma at runtime, only its types. The
// prisma-backed lookups live in bank-accounts-db.ts.

import type { BankAccount, Settings, VatTreatment } from "@prisma/client";

// Tax treatments an account can claim as its own. An invoice whose treatment
// nobody claims falls through to the account flagged isDefault.
export const TREATMENT_RULES: { value: VatTreatment; label: string }[] = [
  { value: "DOMESTIC_ES", label: "Spanish clients (IVA + IRPF)" },
  { value: "INTRA_EU_REVERSE_CHARGE", label: "EU businesses (reverse charge)" },
  { value: "EXPORT_NON_EU", label: "Non-EU clients (export)" },
];

const KNOWN_TREATMENTS = new Set<string>(TREATMENT_RULES.map((t) => t.value));

// defaultForTreatments is stored comma-separated, the same shape
// Settings.telegramAllowedChatIds uses. Unknown values are dropped rather than
// throwing — a treatment removed from the enum must not break invoicing.
export function parseTreatments(csv: string | null | undefined): VatTreatment[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => KNOWN_TREATMENTS.has(s)) as VatTreatment[];
}

export function serializeTreatments(values: string[]): string | null {
  const kept = TREATMENT_RULES.map((t) => t.value).filter((v) => values.includes(v));
  return kept.length > 0 ? kept.join(",") : null;
}

export function treatmentRuleLabel(csv: string | null | undefined): string {
  const list = parseTreatments(csv);
  if (list.length === 0) return "—";
  return list
    .map((v) => TREATMENT_RULES.find((t) => t.value === v)?.label ?? v)
    .join(", ");
}

// Normalised for storage and for AEAT: no spaces, uppercase. The fichero's
// IBAN field is fixed-width and would be corrupted by the pretty spacing.
export function normalizeIban(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

// Human-friendly grouping for the PDF and the UI. Purely cosmetic.
export function formatIban(raw: string): string {
  return normalizeIban(raw).replace(/(.{4})/g, "$1 ").trim();
}

// Rough sanity check — the checksum is not verified, only the shape ES + 2
// check digits + up to 30 alphanumerics as per ISO 13616.
export function looksLikeIban(raw: string): boolean {
  return /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(normalizeIban(raw));
}

// Everything an invoice PDF prints about where the money goes.
export type PaymentDetails = {
  beneficiary: string | null;
  bankName: string;
  iban: string;
  swift: string;
  address: string | null;
  notes: string | null;
};

type Pickable = Pick<BankAccount, "defaultForTreatments" | "isDefault" | "archived">;

// Which account an invoice with this tax treatment should be paid into, given
// the accounts on file. Order: a rule claiming the treatment, then the
// designated default, then whatever is left. An explicit pick on the invoice
// never reaches here — callers apply that first.
export function pickBankAccountFor<T extends Pickable>(
  accounts: T[],
  treatment: VatTreatment
): T | null {
  const usable = accounts.filter((a) => !a.archived);
  return (
    usable.find((a) => parseTreatments(a.defaultForTreatments).includes(treatment)) ??
    usable.find((a) => a.isDefault) ??
    usable[0] ??
    null
  );
}

export function paymentDetailsOf(account: BankAccount): PaymentDetails {
  return {
    beneficiary: account.beneficiary,
    bankName: account.bankName,
    iban: account.iban,
    swift: account.swift,
    address: account.address,
    notes: account.notes,
  };
}

// Fallback for an invoice issued before multi-account support, and for a DB
// that has no accounts at all. These are the very details such an invoice's
// PDF printed at the time, so re-rendering one is unchanged.
export function legacyPaymentDetails(
  settings: Pick<Settings, "bankName" | "bankIban" | "bankSwift" | "bankAddress">
): PaymentDetails {
  return {
    beneficiary: null,
    bankName: settings.bankName,
    iban: settings.bankIban,
    swift: settings.bankSwift,
    address: settings.bankAddress,
    notes: null,
  };
}

export function paymentDetailsFor(
  account: BankAccount | null | undefined,
  settings: Pick<Settings, "bankName" | "bankIban" | "bankSwift" | "bankAddress">
): PaymentDetails {
  return account ? paymentDetailsOf(account) : legacyPaymentDetails(settings);
}
