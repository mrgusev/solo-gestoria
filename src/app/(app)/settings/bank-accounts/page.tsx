import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { prisma } from "@/lib/db";
import { formatIban, treatmentRuleLabel } from "@/lib/bank-accounts";
import { listBankAccounts } from "@/lib/bank-accounts-db";
import { setDefaultBankAccount, toggleArchiveBankAccount } from "./actions";

export default async function BankAccountsPage() {
  const [accounts, counts] = await Promise.all([
    listBankAccounts({ includeArchived: true }),
    prisma.invoice.groupBy({
      by: ["bankAccountId"],
      _count: { _all: true },
    }),
  ]);
  const invoiceCount = new Map(counts.map((c) => [c.bankAccountId, c._count._all]));

  return (
    <>
      <PageHeader
        title="Bank accounts"
        description="Where clients are told to pay. Each invoice keeps the account it was issued with."
        actions={
          <Link
            href="/settings/bank-accounts/new"
            className="rounded-md bg-accent-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-600"
          >
            New account
          </Link>
        }
      />
      <div className="p-6 space-y-4">
        {accounts.length === 0 ? (
          <div className="rounded-md border border-dashed border-neutral-300 p-10 text-center text-sm text-neutral-500">
            No accounts yet.{" "}
            <Link className="underline" href="/settings/bank-accounts/new">
              Add your first
            </Link>
            .
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-neutral-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-2">Account</th>
                  <th className="px-4 py-2">IBAN</th>
                  <th className="px-4 py-2">Default for</th>
                  <th className="px-4 py-2 text-right">Invoices</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr
                    key={a.id}
                    className={`border-t border-neutral-200 hover:bg-neutral-50 ${
                      a.archived ? "text-neutral-400" : ""
                    }`}
                  >
                    <td className="px-4 py-2 font-medium">
                      <Link href={`/settings/bank-accounts/${a.id}/edit`} className="block">
                        {a.label}
                        {a.isDefault ? <Badge title="Used when no rule matches">fallback</Badge> : null}
                        {a.useForAeat ? <Badge title="IBAN sent to AEAT">aeat</Badge> : null}
                        {a.archived ? <Badge title="Hidden from the pickers">archived</Badge> : null}
                      </Link>
                      <div className="text-xs text-neutral-500">
                        {a.bankName} · {a.swift}
                      </div>
                    </td>
                    <td className="px-4 py-2 tabular-nums">{formatIban(a.iban)}</td>
                    <td className="px-4 py-2 text-neutral-700">
                      {treatmentRuleLabel(a.defaultForTreatments)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {invoiceCount.get(a.id) ?? 0}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center justify-end gap-2">
                        {a.isDefault || a.archived ? null : (
                          <form action={setDefaultBankAccount}>
                            <input type="hidden" name="id" value={a.id} />
                            <button type="submit" className={actionClass}>
                              Make fallback
                            </button>
                          </form>
                        )}
                        {a.isDefault ? null : (
                          <form action={toggleArchiveBankAccount}>
                            <input type="hidden" name="id" value={a.id} />
                            <button type="submit" className={actionClass}>
                              {a.archived ? "Un-archive" : "Archive"}
                            </button>
                          </form>
                        )}
                        <Link
                          href={`/settings/bank-accounts/${a.id}/edit`}
                          className={actionClass}
                        >
                          Edit
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-neutral-500">
          A new invoice takes the account whose rule claims the client&apos;s tax treatment, then
          the fallback. You can still override it per invoice in the editor.{" "}
          <Link href="/settings" className="underline">
            Back to settings
          </Link>
        </p>
      </div>
    </>
  );
}

const actionClass =
  "rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-white hover:border-neutral-400";

function Badge({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <span
      className="ml-2 rounded bg-accent-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-700"
      title={title}
    >
      {children}
    </span>
  );
}
