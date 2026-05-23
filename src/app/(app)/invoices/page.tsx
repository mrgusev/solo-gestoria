import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { prisma } from "@/lib/db";
import { formatEUR } from "@/lib/money";
import { isInvoiceLocked } from "@/lib/invoice-lock";

export default async function InvoicesPage() {
  const invoices = await prisma.invoice.findMany({
    orderBy: { date: "desc" },
    include: { client: true },
  });
  return (
    <>
      <PageHeader
        title="Invoices"
        actions={
          <Link
            href="/invoices/new"
            className="rounded-md bg-accent-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-600"
          >
            New monthly invoice
          </Link>
        }
      />
      <div className="p-6">
        {invoices.length === 0 ? (
          <div className="rounded-md border border-dashed border-neutral-300 p-10 text-center text-sm text-neutral-500">
            No invoices yet.{" "}
            <Link className="underline" href="/invoices/new">
              Create your first
            </Link>
            .
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-neutral-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-2">Number</th>
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Client</th>
                  <th className="px-4 py-2 text-right">Total</th>
                  <th className="px-4 py-2 text-right">PDF</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((i) => {
                  const locked = isInvoiceLocked(i);
                  return (
                    <tr
                      key={i.id}
                      className="border-t border-neutral-200 hover:bg-neutral-50"
                    >
                      <td className="px-4 py-2 font-medium">
                        <Link href={`/invoices/${i.id}`} className="block">
                          {i.number}
                          {locked ? (
                            <span
                              className="ml-2 text-[10px] uppercase tracking-wide text-neutral-500"
                              title="Past MOD 303 filing deadline — amend via factura rectificativa"
                            >
                              🔒
                            </span>
                          ) : null}
                        </Link>
                      </td>
                      <td className="px-4 py-2">
                        <Link href={`/invoices/${i.id}`} className="block">
                          {i.date.toISOString().slice(0, 10)}
                        </Link>
                      </td>
                      <td className="px-4 py-2">
                        <Link href={`/invoices/${i.id}`} className="block">
                          {i.client.name}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        <Link href={`/invoices/${i.id}`} className="block">
                          {formatEUR(i.totalCents)}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Link
                          href={`/api/invoices/${i.id}/pdf`}
                          target="_blank"
                          className="inline-flex items-center rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-white hover:border-neutral-400"
                        >
                          ⤓ PDF
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
