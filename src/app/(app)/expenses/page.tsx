import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { prisma } from "@/lib/db";
import { formatEUR } from "@/lib/money";
import { ExpenseUploader } from "./uploader";

export default async function ExpensesPage() {
  const expenses = await prisma.expense.findMany({ orderBy: { date: "desc" } });
  return (
    <>
      <PageHeader
        title="Expenses"
        description="Drag-drop PDFs to auto-extract amounts, dates, and categories."
      />
      <div className="p-6 space-y-6">
        <ExpenseUploader />
        {expenses.length === 0 ? (
          <div className="rounded-md border border-dashed border-neutral-300 p-10 text-center text-sm text-neutral-500">
            No expenses yet.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-neutral-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Vendor</th>
                  <th className="px-4 py-2">Category</th>
                  <th className="px-4 py-2 text-right">Gross</th>
                  <th className="px-4 py-2 text-right">Deductible</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {expenses.map((e) => (
                  <tr
                    key={e.id}
                    className="border-t border-neutral-200 hover:bg-neutral-50"
                  >
                    <td className="px-4 py-2">
                      <Link href={`/expenses/${e.id}`} className="block">
                        {e.date.toISOString().slice(0, 10)}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <Link href={`/expenses/${e.id}`} className="block">
                        {e.vendor}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-xs text-neutral-600">
                      {e.category.replace(/_/g, " ").toLowerCase()}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatEUR(e.grossCents)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatEUR(e.deductibleNetCents + e.deductibleVatCents)}
                      <span className="ml-1 text-xs text-neutral-500">
                        ({e.deductiblePct}%)
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadge status={e.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "CONFIRMED"
      ? "bg-green-50 text-green-700 border-green-200"
      : "bg-amber-50 text-amber-800 border-amber-200";
  return (
    <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${cls}`}>
      {status === "CONFIRMED" ? "Confirmed" : "Review"}
    </span>
  );
}
