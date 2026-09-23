import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { prisma } from "@/lib/db";
import { rateToPct } from "@/lib/invoice-totals";
import { listBankAccounts } from "@/lib/bank-accounts-db";
import RecurringForm from "../RecurringForm";
import { createRecurring } from "../actions";

export default async function NewRecurringPage() {
  const [clients, settings, bankAccounts] = await Promise.all([
    prisma.client.findMany({ orderBy: { name: "asc" } }),
    prisma.settings.findUnique({ where: { id: 1 } }),
    listBankAccounts(),
  ]);
  if (!settings) return <div className="p-6 text-sm text-red-600">Run db:seed first.</div>;
  if (clients.length === 0) {
    return (
      <>
        <PageHeader title="New recurring invoice" />
        <div className="p-6 text-sm text-neutral-600">
          Add a{" "}
          <Link className="underline" href="/clients/new">
            client
          </Link>{" "}
          first — a schedule bills someone.
        </div>
      </>
    );
  }

  const first = clients.find((c) => c.id === settings.defaultClientId) ?? clients[0];
  const today = new Date();
  // Default to the 1st of next month: the common case is billing a month in
  // arrears, and it avoids firing an occurrence the moment you hit save.
  const nextMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1, 12));

  return (
    <>
      <PageHeader
        title="New recurring invoice"
        description="The bot offers each due invoice on Telegram with Issue & send / Skip."
      />
      <RecurringForm
        action={createRecurring}
        submitLabel="Create schedule"
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
          name: "",
          clientId: first.id,
          active: true,
          frequency: "MONTHLY",
          dayOfMonth: 1,
          dueDays: 15,
          startDate: nextMonth.toISOString().slice(0, 10),
          endDate: "",
          emailTo: "",
          emailCc: "",
          notes: "",
          irpfRatePct: rateToPct(first.irpfRetentionRate),
          bankAccountId: "",
          lines: [
            {
              description: settings.defaultLineDescription,
              quantity: 1,
              unit: "ud",
              unitPriceEur: settings.defaultHourlyRateCents / 100,
              vatRatePct: rateToPct(first.defaultVatRate),
            },
          ],
        }}
      />
    </>
  );
}
