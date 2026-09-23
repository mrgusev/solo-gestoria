import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { prisma } from "@/lib/db";
import { formatEUR } from "@/lib/money";
import { computeInvoiceTotals } from "@/lib/invoice-totals";
import { isEmailConfigured } from "@/lib/email";
import {
  describeSchedule,
  nextOccurrenceAfter,
  parseTemplateLines,
} from "@/lib/recurring";
import { toggleRecurring, issueRecurringNow } from "./actions";

function iso(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "—";
}

export default async function RecurringPage() {
  const [schedules, settings] = await Promise.all([
    prisma.recurringInvoice.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
      include: {
        client: true,
        runs: { orderBy: { dueOn: "desc" }, take: 1, include: { invoice: true } },
      },
    }),
    prisma.settings.findUnique({ where: { id: 1 } }),
  ]);
  const now = new Date();
  const emailReady = settings ? isEmailConfigured(settings) : false;

  return (
    <>
      <PageHeader
        title="Recurring invoices"
        description="Standing instructions. Each due occurrence is offered on Telegram — the invoice is only numbered once you confirm."
        actions={
          <Link
            href="/recurring/new"
            className="rounded-md bg-accent-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-600"
          >
            New schedule
          </Link>
        }
      />
      <div className="p-6 space-y-4">
        {!emailReady ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            SMTP isn&apos;t configured, so invoices can be issued but not emailed.{" "}
            <Link className="underline" href="/settings">
              Add your mail server in Settings
            </Link>
            .
          </div>
        ) : null}

        {schedules.length === 0 ? (
          <div className="rounded-md border border-dashed border-neutral-300 p-10 text-center text-sm text-neutral-500">
            No recurring invoices yet.{" "}
            <Link className="underline" href="/recurring/new">
              Create one
            </Link>
            .
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-neutral-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Client</th>
                  <th className="px-4 py-2">Cadence</th>
                  <th className="px-4 py-2">Next</th>
                  <th className="px-4 py-2">Last run</th>
                  <th className="px-4 py-2 text-right">Amount</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => {
                  const lines = parseTemplateLines(s.linesJson);
                  const totals = computeInvoiceTotals(
                    lines.map((l) => ({
                      quantity: l.quantity,
                      unitPriceCents: l.unitPriceCents,
                      vatRate: l.vatRate ?? 0,
                    })),
                    s.irpfRate ?? 0
                  );
                  const last = s.runs[0];
                  const next = s.active ? nextOccurrenceAfter(s, now) : null;
                  return (
                    <tr key={s.id} className="border-t border-neutral-200 hover:bg-neutral-50">
                      <td className="px-4 py-2 font-medium">
                        <Link href={`/recurring/${s.id}/edit`} className="block">
                          {s.name}
                        </Link>
                        {!s.active ? (
                          <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-600">
                            paused
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2">
                        {s.client.name}
                        <div className="text-xs text-neutral-500">
                          {s.emailTo ?? s.client.email ?? "⚠️ no email"}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-neutral-700">{describeSchedule(s)}</td>
                      <td className="px-4 py-2 tabular-nums">{iso(next)}</td>
                      <td className="px-4 py-2">
                        {last ? (
                          <>
                            <div className="tabular-nums">{last.periodKey}</div>
                            <div className="text-xs text-neutral-500">
                              {last.invoice ? (
                                <Link className="underline" href={`/invoices/${last.invoiceId}`}>
                                  {last.invoice.number}
                                </Link>
                              ) : null}{" "}
                              {last.status.toLowerCase().replace(/_/g, " ")}
                            </div>
                          </>
                        ) : (
                          <span className="text-neutral-400">never</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {formatEUR(totals.totalCents)}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center justify-end gap-2">
                          <form action={issueRecurringNow}>
                            <input type="hidden" name="id" value={s.id} />
                            <button
                              type="submit"
                              disabled={!emailReady}
                              title={
                                emailReady
                                  ? "Issue this period's invoice and email it now"
                                  : "Configure SMTP first"
                              }
                              className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-white hover:border-neutral-400 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              Send now
                            </button>
                          </form>
                          <form action={toggleRecurring}>
                            <input type="hidden" name="id" value={s.id} />
                            <button
                              type="submit"
                              className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-white hover:border-neutral-400"
                            >
                              {s.active ? "Pause" : "Resume"}
                            </button>
                          </form>
                          <Link
                            href={`/recurring/${s.id}/edit`}
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
