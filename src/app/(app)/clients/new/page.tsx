import PageHeader from "@/components/PageHeader";
import { prisma } from "@/lib/db";
import { rateToPct } from "@/lib/invoice-totals";
import { countryName, taxPresetForCountry } from "@/lib/clients";
import ClientForm from "../ClientForm";
import { createClient } from "../actions";

export default async function NewClientPage() {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) return <div className="p-6 text-sm text-red-600">Run db:seed first.</div>;

  const defaultVatRatePct = rateToPct(settings.defaultVatRate);
  const defaultIrpfRatePct = rateToPct(settings.defaultIrpfRetentionRate);
  // Default to a Spanish client — that's the case this form mostly exists for.
  const preset = taxPresetForCountry("ES", {
    vatRate: defaultVatRatePct,
    irpfRate: defaultIrpfRatePct,
  });

  return (
    <>
      <PageHeader
        title="New client"
        description="Country picks the tax treatment; every field stays editable."
      />
      <ClientForm
        action={createClient}
        submitLabel="Create client"
        cancelHref="/clients"
        defaultVatRatePct={defaultVatRatePct}
        defaultIrpfRatePct={defaultIrpfRatePct}
        initial={{
          name: "",
          taxId: "",
          vatId: "",
          countryCode: "ES",
          country: countryName("ES"),
          addressLine: "",
          postalCode: "",
          city: "",
          province: "",
          email: "",
          notes: "",
          vatTreatment: preset.vatTreatment,
          vatRatePct: preset.vatRate,
          irpfRatePct: preset.irpfRate,
          invoiceLocale: preset.locale,
        }}
      />
    </>
  );
}
