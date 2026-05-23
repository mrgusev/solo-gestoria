import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import PageHeader from "@/components/PageHeader";
import { prisma } from "@/lib/db";
import { eur, formatEUR } from "@/lib/money";
import { applyDeduction } from "@/lib/deduction";
import { EXPENSE_CATEGORIES } from "@/lib/expense-parser";

async function saveExpense(formData: FormData): Promise<void> {
  "use server";
  const id = String(formData.get("id"));
  const category = String(formData.get("category")) as (typeof EXPENSE_CATEGORIES)[number];
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
  const expense = await prisma.expense.findUnique({ where: { id } });
  if (!expense) notFound();

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
        <form action={saveExpense} className="space-y-4">
          <input type="hidden" name="id" value={expense.id} />

          <div className="grid grid-cols-2 gap-3">
            <Field name="date" label="Date" type="date" defaultValue={expense.date.toISOString().slice(0, 10)} />
            <Field name="vendor" label="Vendor" defaultValue={expense.vendor} />
          </div>

          <label className="block">
            <span className="text-sm font-medium">Category</span>
            <select
              name="category"
              defaultValue={expense.category}
              className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            >
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c.replace(/_/g, " ").toLowerCase()}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <Field
              name="grossEur"
              label="Total gross (€)"
              type="number"
              step="0.01"
              defaultValue={eur(expense.grossCents).toFixed(2)}
            />
            <Field
              name="netEur"
              label="Net base (€)"
              type="number"
              step="0.01"
              defaultValue={eur(expense.netCents).toFixed(2)}
            />
            <Field
              name="vatEur"
              label="VAT (€)"
              type="number"
              step="0.01"
              defaultValue={eur(expense.vatCents).toFixed(2)}
            />
            <Field
              name="vatRate"
              label="VAT rate (0–1)"
              type="number"
              step="0.01"
              defaultValue={expense.vatRate.toString()}
            />
          </div>

          <Field
            name="deductiblePct"
            label="Deductible %"
            type="number"
            min={0}
            max={100}
            defaultValue={String(expense.deductiblePct)}
            hint="Applied to net base AND VAT. For home-office utility bills, this is typically your declared business-use %."
          />

          <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-700 space-y-0.5">
            <div>
              <span className="font-medium">Currently deductible:</span>{" "}
              {formatEUR(expense.deductibleNetCents + expense.deductibleVatCents)}{" "}
              (net {formatEUR(expense.deductibleNetCents)}, VAT {formatEUR(expense.deductibleVatCents)})
            </div>
            <div className="text-neutral-500">
              Status: {expense.status === "CONFIRMED" ? "Confirmed" : "Pending review"} · Source: {expense.source}
            </div>
          </div>

          <label className="block">
            <span className="text-sm font-medium">Notes</span>
            <textarea
              name="notes"
              defaultValue={expense.notes ?? ""}
              rows={2}
              className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
            />
          </label>

          <div className="flex items-center gap-2 pt-2">
            <button
              type="submit"
              className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium hover:bg-neutral-50"
            >
              Save changes
            </button>
            <button
              type="submit"
              name="confirm"
              value="1"
              className="rounded-md bg-accent-500 px-4 py-2 text-sm font-medium text-white hover:bg-accent-600"
            >
              {expense.status === "CONFIRMED" ? "Save (stay confirmed)" : "Confirm"}
            </button>
          </div>
        </form>

        <form action={deleteExpense}>
          <input type="hidden" name="id" value={expense.id} />
          <button
            type="submit"
            className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
          >
            Delete expense
          </button>
        </form>
      </div>
    </>
  );
}

function Field({
  name,
  label,
  defaultValue,
  type = "text",
  step,
  min,
  max,
  hint,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  type?: string;
  step?: string;
  min?: number;
  max?: number;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <input
        name={name}
        type={type}
        step={step}
        min={min}
        max={max}
        defaultValue={defaultValue}
        className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
      />
      {hint ? <span className="mt-1 block text-xs text-neutral-500">{hint}</span> : null}
    </label>
  );
}
