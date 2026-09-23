"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { VatTreatment } from "@prisma/client";
import { prisma } from "@/lib/db";
import { pctToRate } from "@/lib/invoice-totals";
import { countryName } from "@/lib/clients";

const TREATMENTS = new Set<VatTreatment>([
  "DOMESTIC_ES",
  "INTRA_EU_REVERSE_CHARGE",
  "EXPORT_NON_EU",
]);

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function optional(formData: FormData, key: string): string | null {
  const v = str(formData, key);
  return v.length > 0 ? v : null;
}

// The rate inputs are disabled (and therefore absent from the FormData) for
// non-domestic clients — a missing value means "no VAT / no retention".
function rate(formData: FormData, key: string): number {
  const raw = formData.get(key);
  if (raw == null || String(raw).trim() === "") return 0;
  const pct = Number(raw);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new Error(`${key} must be a percentage between 0 and 100`);
  }
  return pctToRate(pct);
}

function readForm(formData: FormData) {
  const name = str(formData, "name");
  if (!name) throw new Error("Name is required");
  const countryCode = str(formData, "countryCode").toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) throw new Error("Country code must be 2 letters");

  const treatmentRaw = str(formData, "vatTreatment") as VatTreatment;
  const vatTreatment: VatTreatment = TREATMENTS.has(treatmentRaw)
    ? treatmentRaw
    : "INTRA_EU_REVERSE_CHARGE";
  const domestic = vatTreatment === "DOMESTIC_ES";

  const localeRaw = str(formData, "invoiceLocale");
  const invoiceLocale = localeRaw === "es" || localeRaw === "en" ? localeRaw : "en";

  return {
    name,
    taxId: optional(formData, "taxId"),
    vatId: optional(formData, "vatId"),
    countryCode,
    country: str(formData, "country") || countryName(countryCode),
    addressLine: str(formData, "addressLine"),
    postalCode: str(formData, "postalCode"),
    city: str(formData, "city"),
    province: optional(formData, "province"),
    email: optional(formData, "email"),
    notes: optional(formData, "notes"),
    vatTreatment,
    // Exempt treatments never carry rates, whatever the form sent.
    defaultVatRate: domestic ? rate(formData, "vatRatePct") : 0,
    irpfRetentionRate: domestic ? rate(formData, "irpfRatePct") : 0,
    invoiceLocale,
  };
}

export async function createClient(formData: FormData): Promise<void> {
  const data = readForm(formData);
  const created = await prisma.client.create({ data, select: { id: true } });
  // First client on a fresh install becomes the default so invoice creation
  // works without a further step.
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (settings && !settings.defaultClientId) {
    await prisma.settings.update({
      where: { id: 1 },
      data: { defaultClientId: created.id },
    });
  }
  revalidatePath("/clients");
  revalidatePath("/invoices/new");
  redirect("/clients");
}

export async function updateClient(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  if (!id) throw new Error("Missing client id");
  const data = readForm(formData);
  await prisma.client.update({ where: { id }, data });
  revalidatePath("/clients");
  revalidatePath("/invoices/new");
  redirect("/clients");
}

export async function deleteClient(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  const [client, invoiceCount, settings] = await Promise.all([
    prisma.client.findUnique({ where: { id }, select: { name: true } }),
    prisma.invoice.count({ where: { clientId: id } }),
    prisma.settings.findUnique({ where: { id: 1 } }),
  ]);
  if (!client) throw new Error("Client not found");
  if (invoiceCount > 0) {
    throw new Error(
      `${client.name} has ${invoiceCount} invoice(s) and cannot be deleted — ` +
        `invoices must stay linked to the client they were issued to.`
    );
  }
  await prisma.client.delete({ where: { id } });
  if (settings?.defaultClientId === id) {
    await prisma.settings.update({ where: { id: 1 }, data: { defaultClientId: null } });
  }
  revalidatePath("/clients");
  revalidatePath("/invoices/new");
  redirect("/clients");
}

export async function setDefaultClient(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  const client = await prisma.client.findUnique({ where: { id }, select: { id: true } });
  if (!client) throw new Error("Client not found");
  await prisma.settings.update({ where: { id: 1 }, data: { defaultClientId: id } });
  revalidatePath("/clients");
  revalidatePath("/invoices/new");
  revalidatePath("/settings");
}
