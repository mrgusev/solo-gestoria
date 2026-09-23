import Link from "next/link";
import { notFound } from "next/navigation";
import PageHeader from "@/components/PageHeader";
import { prisma } from "@/lib/db";
import { rateToPct } from "@/lib/invoice-totals";
import { parseTemplateLines } from "@/lib/recurring";
import { listBankAccounts } from "@/lib/bank-accounts-db";
import RecurringForm from "../../RecurringForm";
import { updateRecurring, deleteRecurring } from "../../actions";

export default async function EditRecurringPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [schedule, clients, bankAccounts] = await Promise.all([
    prisma.recurringInvoice.findUnique({
      where: { id },
      include: {
        runs: { orderBy: { dueOn: "desc" }, take: 12, include: { invoice: true } },
      },
    }),
    prisma.client.findMany({ orderBy: { name: "asc" } }),
    listBankAccounts({ includeArchived: true }),
  ]);
  if (!schedule) notFound();

  const client = clients.find((c) => c.id === schedule.clientId);
  const lines = parseTemplateLines(schedule.linesJson);

  return (
    <>
      <PageHeader
        title={`Edit ${schedule.name}`}
        description="Changes apply to future occurrences. Invoices already issued keep what they were created with."
        actions={
          <form action={deleteRecurring}>
            <input type="hidden" name="id" value={schedule.id} />
            <button
              type="submit"
              className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
            >
              Delete
            </button>
          </form>
        }
      />
      <RecurringForm
        action={updateRecurring}
        scheduleId={schedule.id}
        submitLabel="Save changes"
        cancelHref="/recurring"
        bankAccounts={bankAccounts.map((a) => ({
          id: a.id,
          label: a.label,
          iban: a.iban,
          defaultForTreatments: a.defaultForTreatments,
          isDefault: a.isDefault,
          archived: a.archived,
        }))}
        clients={clients.map((c) => ({
          id: c.id,
          name: c.name,
          email: c.email ?? "",
          vatTreatment: c.vatTreatment,
          vatRatePct: rateToPct(c.defaultVatRate),
          irpfRatePct: rateToPct(c.irpfRetentionRate),
        }))}
        initial={{
          name: schedule.name,
          clientId: schedule.clientId,
          active: schedule.active,
          frequency: schedule.frequency,
          dayOfMonth: schedule.dayOfMonth,
          dueDays: schedule.dueDays,
          startDate: schedule.startDate.toISOString().slice(0, 10),
          endDate: schedule.endDate ? schedule.endDate.toISOString().slice(0, 10) : "",
          emailTo: schedule.emailTo ?? "",
          emailCc: schedule.emailCc ?? "",
          notes: schedule.notes ?? "",
          irpfRatePct: rateToPct(schedule.irpfRate ?? client?.irpfRetentionRate ?? 0),
          bankAccountId: schedule.bankAccountId ?? "",
          lines: lines.map((l) => ({
            description: l.description,
            quantity: l.quantity,
            unit: l.unit ?? "ud",
            unitPriceEur: l.unitPriceCents / 100,
            vatRatePct: rateToPct(l.vatRate ?? client?.defaultVatRate ?? 0),
          })),
        }}
      />

      {schedule.runs.length > 0 ? (
        <div className="px-6 pb-8 max-w-3xl">
          <h2 className="mb-2 text-sm font-medium">History</h2>
          <div className="overflow-x-auto rounded-md border border-neutral-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-2">Period</th>
                  <th className="px-4 py-2">Issue date</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Invoice</th>
                </tr>
              </thead>
              <tbody>
                {schedule.runs.map((r) => (
                  <tr key={r.id} className="border-t border-neutral-200">
                    <td className="px-4 py-2 tabular-nums">{r.periodKey}</td>
                    <td className="px-4 py-2 tabular-nums">
                      {r.dueOn.toISOString().slice(0, 10)}
                    </td>
                    <td className="px-4 py-2">
                      {r.status.toLowerCase().replace(/_/g, " ")}
                      {r.error ? (
                        <div className="text-xs text-red-600">{r.error}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-2">
                      {r.invoice ? (
                        <Link className="underline" href={`/invoices/${r.invoiceId}`}>
                          {r.invoice.number}
                        </Link>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}
