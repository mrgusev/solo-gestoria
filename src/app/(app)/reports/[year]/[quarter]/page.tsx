import Link from "next/link";
import { notFound } from "next/navigation";
import PageHeader from "@/components/PageHeader";
import PeriodNav from "@/components/PeriodNav";
import { prisma } from "@/lib/db";
import { formatEUR } from "@/lib/money";
import { computeQuarterReport, quarterRange, type Quarter } from "@/lib/tax";

type Params = Promise<{ year: string; quarter: string }>;

// Return a sorted list of years with at least one invoice or expense.
async function activeYears(): Promise<number[]> {
  const [invMin, invMax, expMin, expMax] = await Promise.all([
    prisma.invoice.findFirst({ orderBy: { date: "asc" }, select: { date: true } }),
    prisma.invoice.findFirst({ orderBy: { date: "desc" }, select: { date: true } }),
    prisma.expense.findFirst({ orderBy: { date: "asc" }, select: { date: true } }),
    prisma.expense.findFirst({ orderBy: { date: "desc" }, select: { date: true } }),
  ]);
  const dates = [invMin?.date, invMax?.date, expMin?.date, expMax?.date].filter(
    (d): d is Date => d != null
  );
  if (dates.length === 0) return [new Date().getUTCFullYear()];
  const minYear = Math.min(...dates.map((d) => d.getUTCFullYear()));
  const maxYear = Math.max(...dates.map((d) => d.getUTCFullYear()));
  const out: number[] = [];
  for (let y = minYear; y <= maxYear; y++) out.push(y);
  return out;
}

export default async function QuarterReportPage({
  params,
}: {
  params: Params;
}) {
  const { year: yearStr, quarter: qStr } = await params;
  const year = Number(yearStr);
  const q = Number(qStr) as Quarter;
  if (!Number.isFinite(year) || year < 2000 || year > 2100) notFound();
  if (![1, 2, 3, 4].includes(q)) notFound();

  const report = await computeQuarterReport(year, q);
  const { start, endExclusive } = quarterRange(year, q);
  const endInclusive = new Date(endExclusive.getTime() - 86400_000);

  const expensesByCategory = await prisma.expense.groupBy({
    by: ["category"],
    where: {
      status: "CONFIRMED",
      date: { gte: start, lt: endExclusive },
    },
    _sum: {
      grossCents: true,
      deductibleNetCents: true,
      deductibleVatCents: true,
    },
    _count: true,
  });

  // Year range covers any year with recorded activity, plus one ahead/behind
  // for forward planning. Derive from actual invoice/expense dates.
  const yearRange = await activeYears();
  const minY = Math.min(year - 1, ...yearRange);
  const maxY = Math.max(year + 1, ...yearRange);
  const years: number[] = [];
  for (let y = minY; y <= maxY; y++) years.push(y);

  return (
    <>
      <PageHeader
        title={`${year} · Q${q}`}
        description={`${start.toISOString().slice(0, 10)} → ${endInclusive.toISOString().slice(0, 10)}`}
        actions={<PeriodNav year={year} quarter={q} years={years} />}
      />

      <div className="p-6 space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Q income" value={formatEUR(report.period.incomeCents)} />
          <Stat label="Q deductible (net)" value={formatEUR(report.period.deductibleNetCents)} />
          <Stat label="Q deductible VAT" value={formatEUR(report.period.deductibleVatCents)} />
          <Stat
            label="MOD 130 payment"
            value={formatEUR(report.mod130.box07)}
            tone={report.mod130.box07 > 0 ? "warn" : "ok"}
          />
        </div>

        <FormCard
          title="MOD 130 — IRPF quarterly payment"
          subtitle="Pago fraccionado (estimación directa). Cumulative YTD figures, payment per quarter."
          submission={
            <>
              <p>
                Submit at{" "}
                <a
                  className="underline"
                  href="https://sede.agenciatributaria.gob.es/Sede/iva/declaraciones-autoliquidaciones/modelo-130.html"
                  target="_blank"
                  rel="noreferrer"
                >
                  Sede Electrónica → Modelo 130
                </a>
                . Log in with Cl@ve or digital certificate, choose &ldquo;Presentar declaración&rdquo;, period{" "}
                <strong>{year} {q}T</strong>.
              </p>
              <p className="mt-2">
                For an XML pre-fill: click &ldquo;Importar&rdquo; on the form and upload the file from{" "}
                <Link href={`/api/reports/${year}/${q}/aeat/130`} className="underline">
                  Download MOD 130 XML
                </Link>
                .
              </p>
              <p className="mt-2 text-amber-700">
                Deadline: 20th of the month following the quarter (Jan 20, Apr 20, Jul 20, Oct 20).
              </p>
            </>
          }
        >
          <BoxRow box="01" label="Ingresos computables (YTD)" value={report.mod130.box01} />
          <BoxRow box="02" label="Gastos fiscalmente deducibles (YTD)" value={report.mod130.box02} />
          <BoxRow box="03" label="Rendimiento neto (01 − 02)" value={report.mod130.box03} />
          <BoxRow box="04" label="20% de la casilla 03" value={report.mod130.box04} />
          <BoxRow box="05" label="Pagos fraccionados anteriores (suma 07 trimestres previos)" value={report.mod130.box05} />
          <BoxRow box="06" label="Retenciones (0 para cliente intra-EU sin retención)" value={report.mod130.box06} />
          <BoxRow box="07" label="Pago fraccionado del trimestre (04 − 05 − 06)" value={report.mod130.box07} bold />
          <BoxRow box="12" label="Suma pagos del trimestre (07 + 11; 11 = 0)" value={report.mod130.box12} muted />
          <BoxRow box="14" label="Diferencia (12 − 13; 13 = 0)" value={report.mod130.box14} muted />
          <BoxRow box="17" label="Total (14 − 15 − 16; 15 = 16 = 0)" value={report.mod130.box17} muted />
          <BoxRow box="19" label="Resultado a ingresar" value={report.mod130.box19} bold />
        </FormCard>

        <FormCard
          title="MOD 303 — VAT autoliquidación"
          subtitle="No output VAT (all sales are intra-EU services, reverse charge). We only deduct input VAT."
          submission={
            <>
              <p>
                Submit at{" "}
                <a
                  className="underline"
                  href="https://sede.agenciatributaria.gob.es/Sede/iva/declaraciones-autoliquidaciones/modelo-303.html"
                  target="_blank"
                  rel="noreferrer"
                >
                  Sede Electrónica → Modelo 303
                </a>
                , period <strong>{year} {q}T</strong>. The form will ask &ldquo;a compensar&rdquo; — answer yes for{" "}
                <strong>{formatEUR(report.mod303.box72)}</strong>.
              </p>
              <p className="mt-2">
                Pre-fill XML:{" "}
                <Link href={`/api/reports/${year}/${q}/aeat/303`} className="underline">
                  Download MOD 303 XML
                </Link>
                .
              </p>
              <p className="mt-2 text-amber-700">
                Deadline: 20th of the month following the quarter (30th for 4T).
              </p>
            </>
          }
        >
          <BoxRow box="27" label="Total cuota devengada" value={report.mod303.box27} muted />
          <BoxRow box="28" label="Base IVA deducible (operaciones interiores)" value={report.mod303.box28} />
          <BoxRow box="29" label="Cuota IVA deducible (operaciones interiores)" value={report.mod303.box29} />
          <BoxRow box="45" label="Total a deducir" value={report.mod303.box45} />
          <BoxRow box="46" label="Resultado régimen general (27 − 45)" value={report.mod303.box46} />
          <BoxRow box="59" label="Entregas intracomunitarias (bienes y servicios)" value={report.mod303.box59} />
          <BoxRow box="64" label="Suma resultados (46 + 58 + 76)" value={report.mod303.box64} muted />
          <BoxRow box="66" label="Atribuible al Estado (100%)" value={report.mod303.box66} muted />
          <BoxRow box="69" label="Resultado autoliquidación" value={report.mod303.box69} muted />
          <BoxRow box="71" label="Resultado final" value={report.mod303.box71} muted />
          <BoxRow box="72" label="A compensar (si 71 negativo)" value={report.mod303.box72} bold />
        </FormCard>

        <FormCard
          title="MOD 349 — Intra-EU operations recap"
          subtitle="One row per EU client (clave S = services rendered)."
          submission={
            <>
              <p>
                Submit at{" "}
                <a
                  className="underline"
                  href="https://sede.agenciatributaria.gob.es/Sede/iva/declaraciones-autoliquidaciones/modelo-349.html"
                  target="_blank"
                  rel="noreferrer"
                >
                  Sede Electrónica → Modelo 349
                </a>
                , period <strong>{year} {q}T</strong>.
              </p>
              <p className="mt-2">
                Pre-fill XML:{" "}
                <Link href={`/api/reports/${year}/${q}/aeat/349`} className="underline">
                  Download MOD 349 XML
                </Link>
                .
              </p>
              <p className="mt-2 text-amber-700">
                Deadline: 20th of the month following the quarter.
              </p>
            </>
          }
        >
          {report.mod349.length === 0 ? (
            <div className="px-4 py-3 text-sm text-neutral-500">
              No intra-EU operations recorded this quarter.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-2">Country</th>
                  <th className="px-4 py-2">VAT number</th>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Clave</th>
                  <th className="px-4 py-2 text-right">Base</th>
                </tr>
              </thead>
              <tbody>
                {report.mod349.map((row, i) => (
                  <tr key={i} className="border-t border-neutral-200">
                    <td className="px-4 py-2">{row.countryCode}</td>
                    <td className="px-4 py-2 font-mono">{row.vatNumberWithoutPrefix}</td>
                    <td className="px-4 py-2">{row.name}</td>
                    <td className="px-4 py-2">{row.clave}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatEUR(row.baseCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </FormCard>

        <section className="rounded-md border border-neutral-200 bg-white">
          <div className="border-b border-neutral-200 px-4 py-2.5">
            <h2 className="text-sm font-medium">Expenses by category this quarter</h2>
          </div>
          {expensesByCategory.length === 0 ? (
            <div className="p-4 text-sm text-neutral-500">No expenses recorded.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-2">Category</th>
                  <th className="px-4 py-2 text-right"># docs</th>
                  <th className="px-4 py-2 text-right">Gross</th>
                  <th className="px-4 py-2 text-right">Deductible (net)</th>
                  <th className="px-4 py-2 text-right">Deductible VAT</th>
                </tr>
              </thead>
              <tbody>
                {expensesByCategory.map((row) => (
                  <tr key={row.category} className="border-t border-neutral-200">
                    <td className="px-4 py-2 text-neutral-700">
                      {row.category.replace(/_/g, " ").toLowerCase()}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{row._count}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatEUR(row._sum.grossCents ?? 0)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatEUR(row._sum.deductibleNetCents ?? 0)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatEUR(row._sum.deductibleVatCents ?? 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
}) {
  const ring =
    tone === "warn"
      ? "border-amber-300"
      : tone === "ok"
        ? "border-green-300"
        : "border-neutral-200";
  return (
    <div className={`rounded-md border ${ring} bg-white p-4`}>
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function FormCard({
  title,
  subtitle,
  children,
  submission,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  submission: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-neutral-200 bg-white">
      <div className="border-b border-neutral-200 px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-0.5 text-xs text-neutral-500">{subtitle}</p>
      </div>
      <div className="divide-y divide-neutral-100">{children}</div>
      <div className="border-t border-neutral-200 bg-neutral-50 px-4 py-3 text-xs text-neutral-700">
        {submission}
      </div>
    </section>
  );
}

function BoxRow({
  box,
  label,
  value,
  bold,
  muted,
}: {
  box: string;
  label: string;
  value: number;
  bold?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between px-4 py-2 text-sm ${
        muted ? "text-neutral-500" : ""
      }`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className="inline-block w-9 text-xs font-mono text-neutral-500">{box}</span>
        <span className="truncate">{label}</span>
      </div>
      <span className={`tabular-nums ${bold ? "font-semibold" : ""}`}>{formatEUR(value)}</span>
    </div>
  );
}
