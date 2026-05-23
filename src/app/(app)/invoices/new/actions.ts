"use server";

import { redirect } from "next/navigation";
import { createMonthlyInvoice } from "@/lib/invoice";

export async function submitInvoice(formData: FormData): Promise<void> {
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

  const inv = await createMonthlyInvoice({
    date,
    dueDate,
    hours,
    hourlyRateCents: Math.round(hourlyRateEur * 100),
    description: description || undefined,
    clientId: clientId || undefined,
  });
  redirect(`/invoices/${inv.id}`);
}

function parseDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(Date.UTC(y, mo - 1, d, 12));
}
