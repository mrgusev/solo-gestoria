import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import PageHeader from "@/components/PageHeader";
import { prisma } from "@/lib/db";
import { formatEUR } from "@/lib/money";
import { deleteInvoice, lockInvoice, InvoiceLockedError } from "@/lib/invoice";
import { invoiceLockState, lockReasonText } from "@/lib/invoice-lock";

async function deleteAction(formData: FormData) {
  "use server";
  const id = String(formData.get("id"));
  try {
    await deleteInvoice(id);
  } catch (err) {
    if (err instanceof InvoiceLockedError) {
      // Re-throwing surfaces the message to the user via Next's error UI.
      throw new Error(err.message);
    }
    throw err;
  }
  revalidatePath("/invoices");
  redirect("/invoices");
}

async function lockAction(formData: FormData) {
  "use server";
  const id = String(formData.get("id"));
  await lockInvoice(id);
  revalidatePath("/invoices");
  revalidatePath(`/invoices/${id}`);
}

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: { lines: { orderBy: { position: "asc" } }, client: true },
  });
  if (!invoice) notFound();

  const lockState = invoiceLockState(invoice);
  const isLocked = lockState.locked;
  const lockReason = lockReasonText(lockState);

  return (
    <>
      <PageHeader
        title={invoice.number}
        description={`Issued ${invoice.date.toISOString().slice(0, 10)}, due ${invoice.dueDate
          .toISOString()
          .slice(0, 10)}`}
        actions={
          <>
            <Link
              href={`/api/invoices/${invoice.id}/pdf`}
              target="_blank"
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50"
            >
              Download PDF
            </Link>
            {!isLocked && (
              <Link
                href={`/invoices/${invoice.id}/edit`}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50"
              >
                Edit
              </Link>
            )}
            {!isLocked && (
              <form action={lockAction}>
                <input type="hidden" name="id" value={invoice.id} />
                <button
                  type="submit"
                  className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50"
                  title="Mark as final — invoice becomes immutable"
                >
                  🔒 Mark final
                </button>
              </form>
            )}
            {!isLocked && (
              <form action={deleteAction}>
                <input type="hidden" name="id" value={invoice.id} />
                <button
                  type="submit"
                  className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
                >
                  Delete
                </button>
              </form>
            )}
          </>
        }
      />
      {isLocked && lockReason ? (
        <div className="mx-6 mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <span className="font-medium">🔒 Locked</span> · {lockReason}
        </div>
      ) : null}
      <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card title="Client">
          <KV label="Name" value={invoice.client.name} />
          {invoice.client.vatId ? <KV label="VAT ID" value={invoice.client.vatId} /> : null}
          {invoice.client.taxId ? <KV label="Reg. no" value={invoice.client.taxId} /> : null}
          <KV
            label="Address"
            value={`${invoice.client.addressLine}, ${invoice.client.postalCode} ${invoice.client.city}, ${invoice.client.country}`}
          />
          {invoice.client.email ? <KV label="Email" value={invoice.client.email} /> : null}
        </Card>
        <Card title="Totals">
          <KV label="Subtotal" value={formatEUR(invoice.subtotalCents)} />
          <KV label="VAT" value={formatEUR(invoice.vatCents)} />
          <KV label="Total" value={formatEUR(invoice.totalCents)} bold />
          {invoice.vatExempt ? (
            <div className="mt-3 text-xs text-neutral-600">
              <span className="font-medium">VAT exempt:</span> {invoice.exemptionNote}
            </div>
          ) : null}
        </Card>
        <Card title="Lines" className="lg:col-span-2">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="py-2">Description</th>
                <th className="py-2 text-right">Qty</th>
                <th className="py-2 text-right">Unit price</th>
                <th className="py-2 text-right">Net</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((l) => (
                <tr key={l.id} className="border-t border-neutral-200">
                  <td className="py-2">
                    {l.position}. {l.description}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {l.quantity} {l.unit}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {formatEUR(l.unitPriceCents)}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {formatEUR(l.netCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}

function Card({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-md border border-neutral-200 bg-white ${className ?? ""}`}>
      <div className="border-b border-neutral-200 px-4 py-2.5">
        <h2 className="text-sm font-medium">{title}</h2>
      </div>
      <div className="p-4 space-y-2">{children}</div>
    </section>
  );
}

function KV({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-neutral-500">{label}</span>
      <span className={`tabular-nums ${bold ? "font-semibold" : ""}`}>{value}</span>
    </div>
  );
}
