import { notFound, redirect } from "next/navigation";
import PageHeader from "@/components/PageHeader";
import { prisma } from "@/lib/db";
import { eur } from "@/lib/money";
import { isInvoiceLocked } from "@/lib/invoice-lock";
import InvoiceEditForm from "./InvoiceEditForm";

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function EditInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [invoice, clients] = await Promise.all([
    prisma.invoice.findUnique({
      where: { id },
      include: { lines: { orderBy: { position: "asc" } } },
    }),
    prisma.client.findMany({ orderBy: { name: "asc" } }),
  ]);
  if (!invoice) notFound();
  if (isInvoiceLocked(invoice)) {
    // Locked invoices cannot be edited — bounce back to the detail page.
    redirect(`/invoices/${id}`);
  }
  const line = invoice.lines[0];
  return (
    <>
      <PageHeader title={`Edit ${invoice.number}`} description="Changes apply directly. Once the quarter is filed at AEAT, this invoice will lock." />
      <InvoiceEditForm
        invoiceId={invoice.id}
        defaultDate={iso(invoice.date)}
        defaultDueDate={iso(invoice.dueDate)}
        defaultHours={line?.quantity ?? 0}
        defaultRate={line ? eur(line.unitPriceCents) : 0}
        defaultDescription={line?.description ?? ""}
        defaultClientId={invoice.clientId}
        vatExempt={invoice.vatExempt}
        clients={clients.map((c) => ({ id: c.id, name: c.name }))}
      />
    </>
  );
}
