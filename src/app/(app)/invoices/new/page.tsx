import PageHeader from "@/components/PageHeader";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { eur } from "@/lib/money";
import { previewNextInvoiceNumber } from "@/lib/invoice";
import { rateToPct } from "@/lib/invoice-totals";
import InvoiceEditor from "@/components/InvoiceEditor";
import { listBankAccounts } from "@/lib/bank-accounts-db";
import { submitInvoice } from "./actions";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function NewInvoicePage() {
  const [settings, clients, bankAccounts] = await Promise.all([
    prisma.settings.findUnique({ where: { id: 1 } }),
    prisma.client.findMany({ orderBy: { name: "asc" } }),
    listBankAccounts(),
  ]);
  if (!settings) return <div className="p-6 text-sm text-red-600">Run db:seed first.</div>;
  if (clients.length === 0) {
    return (
      <>
        <PageHeader title="New invoice" />
        <div className="p-6 text-sm text-neutral-600">
          No clients yet —{" "}
          <Link className="underline" href="/clients/new">
            add one first
          </Link>
          .
        </div>
      </>
    );
  }

  // Default invoice date: last day of the previous month (typical for monthly
  // billing — invoice the month you just finished).
  const today = new Date();
  const lastDayOfPrevMonth = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0, 12)
  );
  const defaultDate = isoDate(lastDayOfPrevMonth);
  const due = new Date(lastDayOfPrevMonth);
  due.setUTCDate(due.getUTCDate() + 30);
  const defaultDueDate = isoDate(due);

  // Compute the actual next FACT number from existing invoices (not the
  // settings counter, which can drift after bulk imports).
  const nextNumber = await previewNextInvoiceNumber(lastDayOfPrevMonth.getUTCFullYear());

  const options = clients.map((c) => ({
    id: c.id,
    name: c.name,
    vatTreatment: c.vatTreatment,
    vatRatePct: c.vatTreatment === "DOMESTIC_ES" ? rateToPct(c.defaultVatRate) : 0,
    irpfRatePct: c.vatTreatment === "DOMESTIC_ES" ? rateToPct(c.irpfRetentionRate) : 0,
  }));
  const bankAccountOptions = bankAccounts.map((a) => ({
    id: a.id,
    label: a.label,
    iban: a.iban,
    defaultForTreatments: a.defaultForTreatments,
    isDefault: a.isDefault,
    archived: a.archived,
  }));
  const selectedId = settings.defaultClientId ?? clients[0].id;
  const selected = options.find((o) => o.id === selectedId) ?? options[0];

  return (
    <>
      <PageHeader title="New invoice" description={`Next number: ${nextNumber.number}`} />
      <InvoiceEditor
        action={submitInvoice}
        clients={options}
        bankAccounts={bankAccountOptions}
        initialDate={defaultDate}
        initialDueDate={defaultDueDate}
        initialClientId={selected.id}
        initialIrpfRatePct={selected.irpfRatePct}
        initialBankAccountId=""
        initialLines={[
          {
            description: settings.defaultLineDescription,
            quantity: 160,
            unit: "h",
            unitPriceEur: eur(settings.defaultHourlyRateCents),
            vatRatePct: selected.vatRatePct,
          },
        ]}
        submitLabel="Create invoice"
        cancelHref="/invoices"
        syncDueDate
        defaultLineDescription={settings.defaultLineDescription}
        defaultUnitPriceEur={eur(settings.defaultHourlyRateCents)}
      />
    </>
  );
}
