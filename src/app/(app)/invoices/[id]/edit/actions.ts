"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { updateInvoice, InvoiceLockedError } from "@/lib/invoice";
import { parseInvoiceFormLines, parseInvoiceFormDate, parseRatePct } from "@/lib/invoice-form";

export async function submitInvoiceEdit(formData: FormData): Promise<void> {
  const id = String(formData.get("id"));
  const date = parseInvoiceFormDate(String(formData.get("date") ?? ""));
  const dueDate = parseInvoiceFormDate(String(formData.get("dueDate") ?? ""));
  if (!date) throw new Error("Invalid invoice date");
  if (!dueDate) throw new Error("Invalid due date");

  const lines = parseInvoiceFormLines(formData.get("lines"));
  const clientId = String(formData.get("clientId") ?? "");
  const bankAccountId = String(formData.get("bankAccountId") ?? "") || null;

  try {
    await updateInvoice({
      id,
      date,
      dueDate,
      clientId: clientId || undefined,
      lines,
      irpfRate: parseRatePct(formData.get("irpfRatePct")),
      bankAccountId,
    });
  } catch (err) {
    if (err instanceof InvoiceLockedError) throw new Error(err.message);
    throw err;
  }
  revalidatePath("/invoices");
  revalidatePath(`/invoices/${id}`);
  redirect(`/invoices/${id}`);
}
