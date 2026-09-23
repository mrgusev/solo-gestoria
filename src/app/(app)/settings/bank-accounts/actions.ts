"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { looksLikeIban, normalizeIban, serializeTreatments } from "@/lib/bank-accounts";

const LIST_PATH = "/settings/bank-accounts";

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function optional(formData: FormData, key: string): string | null {
  const v = str(formData, key);
  return v.length > 0 ? v : null;
}

function revalidate(): void {
  revalidatePath(LIST_PATH);
  revalidatePath("/settings");
  revalidatePath("/invoices/new");
  revalidatePath("/recurring");
}

function readForm(formData: FormData) {
  const label = str(formData, "label");
  if (!label) throw new Error("Label is required");
  const bankName = str(formData, "bankName");
  if (!bankName) throw new Error("Bank name is required");
  const iban = normalizeIban(str(formData, "iban"));
  if (!looksLikeIban(iban)) {
    throw new Error(`"${iban}" doesn't look like an IBAN (e.g. ES41 1583 0001 1990 0969 2291)`);
  }
  const swift = str(formData, "swift").toUpperCase();
  if (!swift) throw new Error("SWIFT / BIC is required");

  return {
    label,
    beneficiary: optional(formData, "beneficiary"),
    bankName,
    iban,
    swift,
    address: optional(formData, "address"),
    notes: optional(formData, "notes"),
    defaultForTreatments: serializeTreatments(formData.getAll("treatments").map(String)),
    isDefault: formData.get("isDefault") != null,
    useForAeat: formData.get("useForAeat") != null,
  };
}

// isDefault, useForAeat and each treatment rule can only belong to one account
// at a time — an invoice must never have two answers to "where do I get paid".
// Saving an account therefore takes those claims away from the others.
async function enforceExclusiveClaims(
  id: string,
  data: { isDefault: boolean; useForAeat: boolean; defaultForTreatments: string | null }
): Promise<void> {
  if (data.isDefault) {
    await prisma.bankAccount.updateMany({
      where: { id: { not: id }, isDefault: true },
      data: { isDefault: false },
    });
  }
  if (data.useForAeat) {
    await prisma.bankAccount.updateMany({
      where: { id: { not: id }, useForAeat: true },
      data: { useForAeat: false },
    });
  }
  const claimed = data.defaultForTreatments?.split(",") ?? [];
  if (claimed.length === 0) return;
  const others = await prisma.bankAccount.findMany({
    where: { id: { not: id }, defaultForTreatments: { not: null } },
    select: { id: true, defaultForTreatments: true },
  });
  for (const other of others) {
    const kept = (other.defaultForTreatments ?? "")
      .split(",")
      .filter((t) => t && !claimed.includes(t));
    if (kept.length === (other.defaultForTreatments ?? "").split(",").filter(Boolean).length) {
      continue;
    }
    await prisma.bankAccount.update({
      where: { id: other.id },
      data: { defaultForTreatments: kept.length > 0 ? kept.join(",") : null },
    });
  }
}

export async function createBankAccount(formData: FormData): Promise<void> {
  const data = readForm(formData);
  const existing = await prisma.bankAccount.count();
  // The first account has to be the fallback — otherwise nothing would resolve.
  const created = await prisma.bankAccount.create({
    data: {
      ...data,
      isDefault: existing === 0 ? true : data.isDefault,
      useForAeat: existing === 0 ? true : data.useForAeat,
    },
    select: { id: true },
  });
  await enforceExclusiveClaims(created.id, data);
  revalidate();
  redirect(LIST_PATH);
}

export async function updateBankAccount(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  if (!id) throw new Error("Missing bank account id");
  const data = readForm(formData);
  const account = await prisma.bankAccount.findUnique({ where: { id } });
  if (!account) throw new Error("Bank account not found");
  // Un-checking "default" on the only account that has it would leave invoices
  // with no fallback at all, so the flag can only ever move, not vanish.
  if (account.isDefault && !data.isDefault) {
    throw new Error(
      "Mark another account as the default first — one account must stay the fallback."
    );
  }
  await prisma.bankAccount.update({ where: { id }, data });
  await enforceExclusiveClaims(id, data);
  revalidate();
  redirect(LIST_PATH);
}

export async function setDefaultBankAccount(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  const account = await prisma.bankAccount.findUnique({ where: { id } });
  if (!account) throw new Error("Bank account not found");
  if (account.archived) throw new Error("Un-archive the account before making it the default");
  await prisma.bankAccount.updateMany({
    where: { isDefault: true },
    data: { isDefault: false },
  });
  await prisma.bankAccount.update({ where: { id }, data: { isDefault: true } });
  revalidate();
}

// Archiving keeps the row (invoices reference it) but drops it from every
// picker. The default account can't be archived — something has to stay.
export async function toggleArchiveBankAccount(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  const account = await prisma.bankAccount.findUnique({ where: { id } });
  if (!account) throw new Error("Bank account not found");
  if (!account.archived && account.isDefault) {
    throw new Error("Make another account the default before archiving this one");
  }
  await prisma.bankAccount.update({
    where: { id },
    data: {
      archived: !account.archived,
      // An archived account keeps no claims — they'd silently route invoices to
      // an account the pickers no longer offer.
      ...(account.archived ? {} : { useForAeat: false, defaultForTreatments: null }),
    },
  });
  revalidate();
}

export async function deleteBankAccount(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  const [account, invoiceCount, recurringCount] = await Promise.all([
    prisma.bankAccount.findUnique({ where: { id } }),
    prisma.invoice.count({ where: { bankAccountId: id } }),
    prisma.recurringInvoice.count({ where: { bankAccountId: id } }),
  ]);
  if (!account) throw new Error("Bank account not found");
  if (invoiceCount > 0) {
    throw new Error(
      `${account.label} is the payment account on ${invoiceCount} invoice(s) and cannot be ` +
        `deleted — those PDFs must keep printing the details they were issued with. Archive it instead.`
    );
  }
  if (recurringCount > 0) {
    throw new Error(
      `${account.label} is used by ${recurringCount} recurring schedule(s). Point them elsewhere first.`
    );
  }
  if (account.isDefault) {
    throw new Error("Make another account the default before deleting this one");
  }
  await prisma.bankAccount.delete({ where: { id } });
  revalidate();
  redirect(LIST_PATH);
}
