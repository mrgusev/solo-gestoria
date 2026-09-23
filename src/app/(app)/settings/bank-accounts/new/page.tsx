import PageHeader from "@/components/PageHeader";
import { prisma } from "@/lib/db";
import BankAccountForm from "../BankAccountForm";
import { createBankAccount } from "../actions";

export default async function NewBankAccountPage() {
  const [settings, existing] = await Promise.all([
    prisma.settings.findUnique({ where: { id: 1 } }),
    prisma.bankAccount.count(),
  ]);
  if (!settings) return <div className="p-6 text-sm text-red-600">Run db:seed first.</div>;

  return (
    <>
      <PageHeader
        title="New bank account"
        description="Invoices can be routed to it by the client's tax treatment, or picked per invoice."
      />
      <BankAccountForm
        action={createBankAccount}
        submitLabel="Create account"
        cancelHref="/settings/bank-accounts"
        isOnlyAccount={existing === 0}
        issuerName={settings.issuerName}
        initial={{
          label: "",
          beneficiary: "",
          bankName: "",
          iban: "",
          swift: "",
          address: "",
          notes: "",
          defaultForTreatments: null,
          isDefault: existing === 0,
          useForAeat: existing === 0,
        }}
      />
    </>
  );
}
