import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import PageHeader from "@/components/PageHeader";
import { prisma } from "@/lib/db";
import { formatEUR } from "@/lib/money";
import { deleteInvoice, lockInvoice, InvoiceLockedError } from "@/lib/invoice";
import { invoiceLockState, lockReasonText } from "@/lib/invoice-lock";
import { rateToPct } from "@/lib/invoice-totals";
import { vatTreatmentLabel } from "@/lib/clients";
import { formatIban, paymentDetailsFor } from "@/lib/bank-accounts";
import { isEmailConfigured } from "@/lib/email";

// "IVA 21%" when every taxed line shares a rate, plain "IVA" when they differ.
function vatLabel(lines: { vatRate: number }[]): string {
  const rates = [...new Set(lines.map((l) => l.vatRate).filter((r) => r > 0))];
  return rates.length === 1 ? `IVA ${rateToPct(rates[0])}%` : "IVA";
}

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

// Mail this invoice to the client on demand. Same path the recurring cron
// uses, so a successful send here proves the whole SMTP setup.
async function emailAction(formData: FormData) {
  "use server";
  const id = String(formData.get("id"));
  const { sendInvoiceEmail } = await import("@/lib/email");
  await sendInvoiceEmail({ invoiceId: id });
  revalidatePath(`/invoices/${id}`);
}

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [invoice, settings] = await Promise.all([
    prisma.invoice.findUnique({
      where: { id },
      include: { lines: { orderBy: { position: "asc" } }, client: true, bankAccount: true },
    }),
    prisma.settings.findUnique({ where: { id: 1 } }),
  ]);
  if (!invoice) notFound();

  // What the PDF footer prints for this invoice — the account it was issued
  // with, or the legacy settings details for pre-multi-account invoices.
  const bank = settings ? paymentDetailsFor(invoice.bankAccount, settings) : null;
  const emailReady = settings ? isEmailConfigured(settings) : false;
  const canEmail = emailReady && Boolean(invoice.client.email);
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
            <form action={emailAction}>
              <input type="hidden" name="id" value={invoice.id} />
              <button
                type="submit"
                disabled={!canEmail}
                title={
                  !emailReady
                    ? "Configure SMTP in Settings first"
                    : !invoice.client.email
                      ? "This client has no email address"
                      : invoice.emailedAt
                        ? `Last sent ${invoice.emailedAt.toISOString().slice(0, 10)} to ${invoice.emailedTo ?? ""}`
                        : "Email the PDF to the client"
                }
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {invoice.emailedAt ? "✉️ Send again" : "✉️ Email to client"}
              </button>
            </form>
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
          {bank ? (
            <KV
              label="Paid into"
              value={`${invoice.bankAccount?.label ?? bank.bankName} · ${formatIban(bank.iban)}`}
            />
          ) : null}
          {invoice.emailedAt ? (
            <KV
              label="Emailed"
              value={`${invoice.emailedAt.toISOString().slice(0, 16).replace("T", " ")} → ${invoice.emailedTo ?? ""}`}
            />
          ) : null}
        </Card>
        <Card title="Totals">
          <KV label="Base imponible" value={formatEUR(invoice.subtotalCents)} />
          <KV label={vatLabel(invoice.lines)} value={formatEUR(invoice.vatCents)} />
          {invoice.irpfCents > 0 ? (
            <KV
              label={`Retención IRPF ${rateToPct(invoice.irpfRate)}%`}
              value={`-${formatEUR(invoice.irpfCents)}`}
            />
          ) : null}
          <KV label="Total" value={formatEUR(invoice.totalCents)} bold />
          <div className="mt-3 text-xs text-neutral-600">
            <span className="font-medium">Treatment:</span>{" "}
            {vatTreatmentLabel(invoice.vatTreatment)}
          </div>
          {invoice.vatExempt && invoice.exemptionNote ? (
            <div className="mt-1 text-xs text-neutral-600">{invoice.exemptionNote}</div>
          ) : null}
        </Card>
        <Card title="Lines" className="lg:col-span-2">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="py-2">Description</th>
                <th className="py-2 text-right">Qty</th>
                <th className="py-2 text-right">Unit price</th>
                <th className="py-2 text-right">IVA</th>
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
                  <td className="py-2 text-right tabular-nums">{rateToPct(l.vatRate)}%</td>
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
