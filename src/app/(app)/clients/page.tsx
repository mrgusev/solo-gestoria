import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { prisma } from "@/lib/db";
import { rateToPct } from "@/lib/invoice-totals";
import { vatTreatmentLabel } from "@/lib/clients";
import { setDefaultClient } from "./actions";

export default async function ClientsPage() {
  const [clients, settings] = await Promise.all([
    prisma.client.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { invoices: true } } },
    }),
    prisma.settings.findUnique({ where: { id: 1 } }),
  ]);

  return (
    <>
      <PageHeader
        title="Clients"
        description="Each client carries its own VAT treatment — new invoices inherit it."
        actions={
          <Link
            href="/clients/new"
            className="rounded-md bg-accent-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-600"
          >
            New client
          </Link>
        }
      />
      <div className="p-6">
        {clients.length === 0 ? (
          <div className="rounded-md border border-dashed border-neutral-300 p-10 text-center text-sm text-neutral-500">
            No clients yet.{" "}
            <Link className="underline" href="/clients/new">
              Add your first
            </Link>
            .
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-neutral-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Country</th>
                  <th className="px-4 py-2">Treatment</th>
                  <th className="px-4 py-2 text-right">IVA</th>
                  <th className="px-4 py-2 text-right">IRPF</th>
                  <th className="px-4 py-2 text-right">Invoices</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => {
                  const isDefault = settings?.defaultClientId === c.id;
                  return (
                    <tr key={c.id} className="border-t border-neutral-200 hover:bg-neutral-50">
                      <td className="px-4 py-2 font-medium">
                        <Link href={`/clients/${c.id}/edit`} className="block">
                          {c.name}
                          {isDefault ? (
                            <span
                              className="ml-2 rounded bg-accent-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-700"
                              title="Used when an invoice is created without picking a client"
                            >
                              default
                            </span>
                          ) : null}
                        </Link>
                        {c.taxId ? (
                          <div className="text-xs text-neutral-500">{c.taxId}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-2">
                        {c.country}
                        <span className="ml-1 text-xs text-neutral-500">({c.countryCode})</span>
                      </td>
                      <td className="px-4 py-2 text-neutral-700">
                        {vatTreatmentLabel(c.vatTreatment)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {c.vatTreatment === "DOMESTIC_ES" ? `${rateToPct(c.defaultVatRate)}%` : "—"}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {c.vatTreatment === "DOMESTIC_ES"
                          ? `${rateToPct(c.irpfRetentionRate)}%`
                          : "—"}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{c._count.invoices}</td>
                      <td className="px-4 py-2">
                        <div className="flex items-center justify-end gap-2">
                          {isDefault ? null : (
                            <form action={setDefaultClient}>
                              <input type="hidden" name="id" value={c.id} />
                              <button
                                type="submit"
                                className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-white hover:border-neutral-400"
                              >
                                Make default
                              </button>
                            </form>
                          )}
                          <Link
                            href={`/clients/${c.id}/edit`}
                            className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-white hover:border-neutral-400"
                          >
                            Edit
                          </Link>
                        </div>
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
