"use server";

import { redirect } from "next/navigation";
import { createInvoice } from "@/lib/invoice";
import { parseInvoiceFormLines, parseInvoiceFormDate, parseRatePct } from "@/lib/invoice-form";

export async function submitInvoice(formData: FormData): Promise<void> {
  const date = parseInvoiceFormDate(String(formData.get("date") ?? ""));
  const dueDate = parseInvoiceFormDate(String(formData.get("dueDate") ?? ""));
  if (!date) throw new Error("Invalid invoice date");
  if (!dueDate) throw new Error("Invalid due date");

  const lines = parseInvoiceFormLines(formData.get("lines"));
  const clientId = String(formData.get("clientId") ?? "");
  // Empty means "automatic" — createInvoice then resolves the account from the
  // client's tax treatment.
  const bankAccountId = String(formData.get("bankAccountId") ?? "") || null;

  const inv = await createInvoice({
    date,
    dueDate,
    clientId: clientId || undefined,
    lines,
    irpfRate: parseRatePct(formData.get("irpfRatePct")),
    bankAccountId,
  });
  redirect(`/invoices/${inv.id}`);
}
