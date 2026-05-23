import PageHeader from "@/components/PageHeader";
import { prisma } from "@/lib/db";
import { eur } from "@/lib/money";
import { previewNextInvoiceNumber } from "@/lib/invoice";
import InvoiceForm from "./InvoiceForm";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function NewInvoicePage() {
  const [settings, clients] = await Promise.all([
    prisma.settings.findUnique({ where: { id: 1 } }),
    prisma.client.findMany({ orderBy: { name: "asc" } }),
  ]);
  if (!settings) return <div className="p-6 text-sm text-red-600">Run db:seed first.</div>;

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

  return (
    <>
      <PageHeader
        title="New invoice"
        description={`Next number: ${nextNumber.number}`}
      />
      <InvoiceForm
        defaultDate={defaultDate}
        defaultDueDate={defaultDueDate}
        defaultHours={160}
        defaultRate={eur(settings.defaultHourlyRateCents)}
        defaultDescription={settings.defaultLineDescription}
        vatExempt={true}
        clients={clients.map((c) => ({ id: c.id, name: c.name }))}
        defaultClientId={settings.defaultClientId ?? clients[0]?.id ?? ""}
      />
    </>
  );
}
