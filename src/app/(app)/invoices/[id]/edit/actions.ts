"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { updateInvoice, InvoiceLockedError } from "@/lib/invoice";

export async function submitInvoiceEdit(formData: FormData): Promise<void> {
  const id = String(formData.get("id"));
  const dateStr = String(formData.get("date") ?? "");
  const dueDateStr = String(formData.get("dueDate") ?? "");
  const hours = Number(formData.get("hours"));
  const hourlyRateEur = Number(formData.get("hourlyRate"));
  const description = String(formData.get("description") ?? "").trim();
  const clientId = String(formData.get("clientId") ?? "");

  const date = parseDate(dateStr);
  const dueDate = parseDate(dueDateStr);
  if (!date) throw new Error("Invalid invoice date");
  if (!dueDate) throw new Error("Invalid due date");
  if (!Number.isFinite(hours) || hours <= 0) throw new Error("Hours must be > 0");

  try {
    await updateInvoice({
      id,
      date,
      dueDate,
      hours,
      hourlyRateCents: Math.round(hourlyRateEur * 100),
      description: description || undefined,
      clientId: clientId || undefined,
    });
  } catch (err) {
    if (err instanceof InvoiceLockedError) throw new Error(err.message);
    throw err;
  }
  revalidatePath("/invoices");
  revalidatePath(`/invoices/${id}`);
  redirect(`/invoices/${id}`);
}

function parseDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
}
