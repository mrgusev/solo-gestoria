import { notFound } from "next/navigation";
import PageHeader from "@/components/PageHeader";
import { prisma } from "@/lib/db";
import BankAccountForm from "../../BankAccountForm";
import { updateBankAccount, deleteBankAccount } from "../../actions";

export default async function EditBankAccountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [account, settings, total, invoiceCount, recurringCount] = await Promise.all([
    prisma.bankAccount.findUnique({ where: { id } }),
    prisma.settings.findUnique({ where: { id: 1 } }),
    prisma.bankAccount.count(),
    prisma.invoice.count({ where: { bankAccountId: id } }),
    prisma.recurringInvoice.count({ where: { bankAccountId: id } }),
  ]);
  if (!account) notFound();
  if (!settings) return <div className="p-6 text-sm text-red-600">Run db:seed first.</div>;

  const inUse = invoiceCount > 0 || recurringCount > 0;

  return (
    <>
      <PageHeader
        title={`Edit ${account.label}`}
        description={
          invoiceCount > 0
            ? `${invoiceCount} invoice(s) point here — editing these details changes what their PDFs print when re-rendered.`
            : "Not used by any invoice yet."
        }
        actions={
          inUse || account.isDefault ? null : (
            <form action={deleteBankAccount}>
              <input type="hidden" name="id" value={account.id} />
              <button
                type="submit"
                className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
              >
                Delete
              </button>
            </form>
          )
        }
      />
      <BankAccountForm
        action={updateBankAccount}
        submitLabel="Save changes"
        cancelHref="/settings/bank-accounts"
        isOnlyAccount={total === 1}
        issuerName={settings.issuerName}
        initial={{
          id: account.id,
          label: account.label,
          beneficiary: account.beneficiary ?? "",
          bankName: account.bankName,
          iban: account.iban,
          swift: account.swift,
          address: account.address ?? "",
          notes: account.notes ?? "",
          defaultForTreatments: account.defaultForTreatments,
          isDefault: account.isDefault,
          useForAeat: account.useForAeat,
        }}
      />
    </>
  );
}
