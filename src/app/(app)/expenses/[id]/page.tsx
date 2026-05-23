import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { ExpenseCategory } from "@prisma/client";
import PageHeader from "@/components/PageHeader";
import { prisma } from "@/lib/db";
import { applyDeduction, defaultDeductiblePct } from "@/lib/deduction";
import { EXPENSE_CATEGORIES } from "@/lib/expense-parser";
import ExpenseEditForm from "./edit-form";

async function saveExpense(formData: FormData): Promise<void> {
  "use server";
  const id = String(formData.get("id"));
  const category = String(formData.get("category")) as ExpenseCategory;
  const date = new Date(String(formData.get("date")) + "T12:00:00.000Z");
  const vendor = String(formData.get("vendor"));
  const grossEur = Number(formData.get("grossEur"));
  const netEur = Number(formData.get("netEur"));
  const vatEur = Number(formData.get("vatEur"));
  const vatRate = Number(formData.get("vatRate"));
  const deductiblePct = Number(formData.get("deductiblePct"));
  const notes = String(formData.get("notes") ?? "").trim();
  const confirm = formData.get("confirm") === "1";

  const grossCents = Math.round(grossEur * 100);
  const netCents = Math.round(netEur * 100);
  const vatCents = Math.round(vatEur * 100);
  const ded = applyDeduction(deductiblePct, netCents, vatCents);

  await prisma.expense.update({
    where: { id },
    data: {
      category,
      date,
      vendor,
      grossCents,
      netCents,
      vatRate,
      vatCents,
      deductiblePct,
      deductibleNetCents: ded.deductibleNetCents,
      deductibleVatCents: ded.deductibleVatCents,
      notes: notes || null,
      status: confirm ? "CONFIRMED" : undefined,
    },
  });
  revalidatePath("/expenses");
  revalidatePath(`/expenses/${id}`);
  if (confirm) redirect("/expenses");
}

async function deleteExpense(formData: FormData): Promise<void> {
  "use server";
  const id = String(formData.get("id"));
  await prisma.expense.delete({ where: { id } });
  revalidatePath("/expenses");
  redirect("/expenses");
}

export default async function ExpenseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [expense, settings] = await Promise.all([
    prisma.expense.findUnique({ where: { id } }),
    prisma.settings.findUnique({ where: { id: 1 } }),
  ]);
  if (!expense || !settings) notFound();

  // Pre-compute the default deductible % for each category so the client form
  // can update on category change without round-tripping. Uses the expense's
  // own date so home-office cutoff logic resolves correctly.
  const categoryDefaults = Object.fromEntries(
    EXPENSE_CATEGORIES.map((c) => [c, defaultDeductiblePct(c, settings, expense.date)]),
  ) as Record<ExpenseCategory, number>;

  return (
    <>
      <PageHeader
        title={expense.vendor}
        description={`${expense.date.toISOString().slice(0, 10)} · ${expense.category.replace(/_/g, " ").toLowerCase()}`}
        actions={
          expense.pdfPath ? (
            <Link
              href={`/api/expenses/${expense.id}/pdf`}
              target="_blank"
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50"
            >
              Open source PDF
            </Link>
          ) : null
        }
      />
      <div className="p-6 max-w-2xl space-y-5">
        <ExpenseEditForm
          expense={expense}
          categoryDefaults={categoryDefaults}
          saveAction={saveExpense}
          deleteAction={deleteExpense}
        />
      </div>
    </>
  );
}
