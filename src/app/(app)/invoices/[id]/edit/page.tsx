import { notFound, redirect } from "next/navigation";
import PageHeader from "@/components/PageHeader";
import { prisma } from "@/lib/db";
import { eur } from "@/lib/money";
import { isInvoiceLocked } from "@/lib/invoice-lock";
import { rateToPct } from "@/lib/invoice-totals";
import InvoiceEditor from "@/components/InvoiceEditor";
import { listBankAccounts } from "@/lib/bank-accounts-db";
import { submitInvoiceEdit } from "./actions";

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function EditInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [invoice, clients, settings, bankAccounts] = await Promise.all([
    prisma.invoice.findUnique({
      where: { id },
      include: { lines: { orderBy: { position: "asc" } } },
    }),
    prisma.client.findMany({ orderBy: { name: "asc" } }),
    prisma.settings.findUnique({ where: { id: 1 } }),
    // Archived accounts included: an invoice that already points at one must
    // keep showing it rather than silently switching to another account.
    listBankAccounts({ includeArchived: true }),
  ]);
  if (!invoice) notFound();
  if (!settings) return <div className="p-6 text-sm text-red-600">Run db:seed first.</div>;
  if (isInvoiceLocked(invoice)) {
    // Locked invoices cannot be edited — bounce back to the detail page.
    redirect(`/invoices/${id}`);
  }

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

  return (
    <>
      <PageHeader
        title={`Edit ${invoice.number}`}
        description="Changes apply directly. Once the quarter is filed at AEAT, this invoice will lock."
      />
      <InvoiceEditor
        action={submitInvoiceEdit}
        invoiceId={invoice.id}
        clients={options}
        bankAccounts={bankAccountOptions}
        initialDate={iso(invoice.date)}
        initialDueDate={iso(invoice.dueDate)}
        initialClientId={invoice.clientId}
        initialIrpfRatePct={rateToPct(invoice.irpfRate)}
        initialBankAccountId={invoice.bankAccountId ?? ""}
        initialLines={invoice.lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unit: l.unit,
          unitPriceEur: eur(l.unitPriceCents),
          vatRatePct: rateToPct(l.vatRate),
        }))}
        submitLabel="Save changes"
        cancelHref={`/invoices/${invoice.id}`}
        defaultLineDescription={settings.defaultLineDescription}
        defaultUnitPriceEur={eur(settings.defaultHourlyRateCents)}
      />
    </>
  );
}
