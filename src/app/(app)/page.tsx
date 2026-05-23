import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import MonthlyCharts from "@/components/MonthlyCharts";
import YearTabs from "@/components/YearTabs";
import { prisma } from "@/lib/db";
import { formatEUR } from "@/lib/money";
import { quarterOf, computeQuarterReport } from "@/lib/tax";
import { monthlyTotals, activeYearsList } from "@/lib/dashboard";

function currentQuarter(): { year: number; quarter: 1 | 2 | 3 | 4 } {
  const now = new Date();
  return { year: now.getUTCFullYear(), quarter: quarterOf(now) };
}

type SearchParams = Promise<{ year?: string }>;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { year: chartYearStr } = await searchParams;
  const { year, quarter } = currentQuarter();
  const [settings, report, years] = await Promise.all([
    prisma.settings.findUnique({ where: { id: 1 } }),
    computeQuarterReport(year, quarter),
    activeYearsList(),
  ]);

  // Year shown in the charts — default to current year, else the most recent
  // year with activity.
  const requested = Number(chartYearStr);
  const chartYear = Number.isFinite(requested) && years.includes(requested)
    ? requested
    : years.includes(year) ? year : years[years.length - 1];
  const months = await monthlyTotals(chartYear);

  const stats = [
    { label: "Q income", value: formatEUR(report.period.incomeCents) },
    { label: "Q deductible (net)", value: formatEUR(report.period.deductibleNetCents) },
    { label: "Q deductible VAT", value: formatEUR(report.period.deductibleVatCents) },
    { label: "MOD 130 payment", value: formatEUR(report.mod130.box07) },
  ];

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`Year ${year} · Q${quarter}`}
        actions={
          <>
            <Link
              href="/invoices/new"
              className="rounded-md bg-accent-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-600"
            >
              + New invoice
            </Link>
            <Link
              href="/expenses"
              className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
            >
              Upload expense
            </Link>
          </>
        }
      />
      <div className="p-6 space-y-8">
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-medium text-neutral-700">
              This quarter
            </h2>
            <span className="text-xs text-neutral-500">Q{quarter} {year}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {stats.map((s) => (
              <div key={s.label} className="rounded-md border border-neutral-200 bg-white p-4">
                <div className="text-xs uppercase tracking-wide text-neutral-500">{s.label}</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">{s.value}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-neutral-700">
              Annual overview
            </h2>
            <YearTabs years={years} current={chartYear} basePath="/" />
          </div>
          <MonthlyCharts months={months} />
        </section>

        {!settings || settings.retaMonthlyCuotaCents === 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm">
            <div className="font-medium text-amber-900">Finish setup</div>
            <div className="text-amber-800 mt-1">
              Visit <Link className="underline" href="/settings">Settings</Link> to set your RETA monthly cuota and home-office percentage.
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
