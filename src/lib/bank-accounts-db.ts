// Prisma-backed lookups for the payment destinations. Split out of
// bank-accounts.ts so that module stays importable from client components.
// No `server-only` guard here — prisma/seed.ts and the bot scripts import it.

import type { BankAccount, VatTreatment } from "@prisma/client";
import { prisma } from "./db";
import { pickBankAccountFor } from "./bank-accounts";

// Default first, then alphabetical — the order the pickers and the settings
// list both want.
const LIST_ORDER = [{ isDefault: "desc" as const }, { label: "asc" as const }];

export async function listBankAccounts(
  opts: { includeArchived?: boolean } = {}
): Promise<BankAccount[]> {
  return prisma.bankAccount.findMany({
    where: opts.includeArchived ? {} : { archived: false },
    orderBy: LIST_ORDER,
  });
}

// The account an invoice with this treatment should be paid into. `explicitId`
// is the user's own pick and always wins — including when it names an archived
// account, so editing an old invoice can't silently move its payment details.
// Returns null only when there are no accounts on file at all, in which case
// the PDF falls back to the legacy Settings.bank* fields.
export async function resolveBankAccountId(
  treatment: VatTreatment,
  explicitId?: string | null
): Promise<string | null> {
  if (explicitId) {
    const picked = await prisma.bankAccount.findUnique({
      where: { id: explicitId },
      select: { id: true },
    });
    if (picked) return picked.id;
  }
  const accounts = await listBankAccounts({ includeArchived: true });
  return pickBankAccountFor(accounts, treatment)?.id ?? null;
}

// IBAN AEAT should refund into / direct-debit from on modelo 303 and 130.
// The account explicitly flagged for it, else the invoicing default, else the
// legacy settings field.
export async function resolveAeatIban(settings: { bankIban: string }): Promise<string> {
  const accounts = await listBankAccounts();
  const flagged = accounts.find((a) => a.useForAeat);
  const fallback = accounts.find((a) => a.isDefault) ?? accounts[0];
  return flagged?.iban ?? fallback?.iban ?? settings.bankIban;
}

// One-time upgrade path: an install that predates this table keeps its bank
// details in Settings.bank*. Turn them into the first account and point the
// existing invoices at it, so their PDFs re-render byte-identical.
//
// Idempotent — does nothing once any account exists. Called from prisma/seed.ts,
// which the container entrypoint runs on every boot.
export async function bootstrapBankAccounts(): Promise<BankAccount | null> {
  if ((await prisma.bankAccount.count()) > 0) return null;
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings || !settings.bankIban) return null;

  const created = await prisma.bankAccount.create({
    data: {
      label: settings.bankName,
      bankName: settings.bankName,
      iban: settings.bankIban,
      swift: settings.bankSwift,
      address: settings.bankAddress,
      isDefault: true,
      useForAeat: true,
    },
  });
  await prisma.invoice.updateMany({
    where: { bankAccountId: null },
    data: { bankAccountId: created.id },
  });
  // Recurring schedules are deliberately left on "auto": a null there means
  // "resolve from the client's treatment at issue time", which is what a
  // schedule should keep doing once more accounts are added.
  return created;
}
