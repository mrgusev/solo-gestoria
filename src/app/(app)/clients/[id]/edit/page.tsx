import { notFound } from "next/navigation";
import PageHeader from "@/components/PageHeader";
import { prisma } from "@/lib/db";
import { rateToPct } from "@/lib/invoice-totals";
import ClientForm from "../../ClientForm";
import { updateClient, deleteClient } from "../../actions";

export default async function EditClientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [client, settings, invoiceCount] = await Promise.all([
    prisma.client.findUnique({ where: { id } }),
    prisma.settings.findUnique({ where: { id: 1 } }),
    prisma.invoice.count({ where: { clientId: id } }),
  ]);
  if (!client) notFound();
  if (!settings) return <div className="p-6 text-sm text-red-600">Run db:seed first.</div>;

  return (
    <>
      <PageHeader
        title={`Edit ${client.name}`}
        description={
          invoiceCount > 0
            ? `${invoiceCount} invoice(s) issued. Changes apply to future invoices only — issued ones keep the treatment they were created with.`
            : "No invoices issued yet."
        }
        actions={
          invoiceCount === 0 ? (
            <form action={deleteClient}>
              <input type="hidden" name="id" value={client.id} />
              <button
                type="submit"
                className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
              >
                Delete
              </button>
            </form>
          ) : null
        }
      />
      <ClientForm
        action={updateClient}
        submitLabel="Save changes"
        cancelHref="/clients"
        defaultVatRatePct={rateToPct(settings.defaultVatRate)}
        defaultIrpfRatePct={rateToPct(settings.defaultIrpfRetentionRate)}
        initial={{
          id: client.id,
          name: client.name,
          taxId: client.taxId ?? "",
          vatId: client.vatId ?? "",
          countryCode: client.countryCode,
          country: client.country,
          addressLine: client.addressLine,
          postalCode: client.postalCode,
          city: client.city,
          province: client.province ?? "",
          email: client.email ?? "",
          notes: client.notes ?? "",
          vatTreatment: client.vatTreatment,
          vatRatePct: rateToPct(client.defaultVatRate),
          irpfRatePct: rateToPct(client.irpfRetentionRate),
          invoiceLocale: client.invoiceLocale,
        }}
      />
    </>
  );
}
