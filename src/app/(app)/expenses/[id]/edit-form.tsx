"use client";

import { useState } from "react";
import type { Expense, ExpenseCategory } from "@prisma/client";
import { eur, formatEUR } from "@/lib/money";
import { EXPENSE_CATEGORIES } from "@/lib/expense-parser";

type Props = {
  expense: Expense;
  categoryDefaults: Record<ExpenseCategory, number>;
  saveAction: (formData: FormData) => Promise<void>;
  deleteAction: (formData: FormData) => Promise<void>;
};

export default function ExpenseEditForm({
  expense,
  categoryDefaults,
  saveAction,
  deleteAction,
}: Props) {
  const [category, setCategory] = useState<ExpenseCategory>(expense.category);
  const [deductiblePct, setDeductiblePct] = useState(String(expense.deductiblePct));

  function onCategoryChange(next: ExpenseCategory) {
    setCategory(next);
    setDeductiblePct(String(categoryDefaults[next]));
  }

  return (
    <>
      <form action={saveAction} className="space-y-4">
        <input type="hidden" name="id" value={expense.id} />

        <div className="grid grid-cols-2 gap-3">
          <Field
            name="date"
            label="Date"
            type="date"
            defaultValue={expense.date.toISOString().slice(0, 10)}
          />
          <Field name="vendor" label="Vendor" defaultValue={expense.vendor} />
        </div>

        <label className="block">
          <span className="text-sm font-medium">Category</span>
          <select
            name="category"
            value={category}
            onChange={(e) => onCategoryChange(e.target.value as ExpenseCategory)}
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

        <label className="block">
          <span className="text-sm font-medium">Deductible %</span>
          <input
            name="deductiblePct"
            type="number"
            min={0}
            max={100}
            step="0.01"
            value={deductiblePct}
            onChange={(e) => setDeductiblePct(e.target.value)}
            className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
          />
          <span className="mt-1 block text-xs text-neutral-500">
            Auto-set from category. Override if needed (e.g. partial business use).
          </span>
        </label>

        <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-700 space-y-0.5">
          <div>
            <span className="font-medium">Currently deductible:</span>{" "}
            {formatEUR(expense.deductibleNetCents + expense.deductibleVatCents)} (net{" "}
            {formatEUR(expense.deductibleNetCents)}, VAT {formatEUR(expense.deductibleVatCents)})
          </div>
          <div className="text-neutral-500">
            Status: {expense.status === "CONFIRMED" ? "Confirmed" : "Pending review"} · Source:{" "}
            {expense.source}
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

      <form action={deleteAction}>
        <input type="hidden" name="id" value={expense.id} />
        <button
          type="submit"
          className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
        >
          Delete expense
        </button>
      </form>
    </>
  );
}

function Field({
  name,
  label,
  defaultValue,
  type = "text",
  step,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  type?: string;
  step?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <input
        name={name}
        type={type}
        step={step}
        defaultValue={defaultValue}
        className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
      />
    </label>
  );
}
