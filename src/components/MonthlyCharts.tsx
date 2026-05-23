"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ComposedChart,
  Line,
} from "recharts";
import type { TooltipContentProps } from "recharts";
import type { ExpenseCategory } from "@prisma/client";
import { CATEGORY_COLOR, CATEGORY_LABEL, type MonthPoint } from "@/lib/dashboard-shared";

// Categories worth charting (NON_DEDUCTIBLE excluded — by definition has 0 deduction).
const CHART_CATEGORIES: ExpenseCategory[] = [
  "RENT_HOUSING",
  "SOCIAL_SECURITY",
  "GESTORIA",
  "UTILITY_ELECTRICITY",
  "UTILITY_GAS",
  "UTILITY_WATER",
  "UTILITY_INTERNET",
  "SOFTWARE",
  "BANK_FEES",
  "OTHER_DEDUCTIBLE",
];

type ChartRow = {
  label: string;
  income: number;
  totalDeductible: number;
} & Partial<Record<ExpenseCategory, number>>;

function toEurRows(months: MonthPoint[]): ChartRow[] {
  return months.map((m) => {
    const row: ChartRow = {
      label: m.label,
      income: m.incomeCents / 100,
      totalDeductible: m.totalDeductibleCents / 100,
    };
    for (const cat of CHART_CATEGORIES) {
      const v = m.byCategory[cat];
      if (v && v > 0) row[cat] = Math.round(v) / 100;
    }
    return row;
  });
}

function fmt(value: number | string | undefined): string {
  if (typeof value !== "number") return String(value ?? "");
  return new Intl.NumberFormat("es-ES", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Math.round(value)) + " €";
}

const AXIS_TICK = { fontSize: 11, fill: "#64748b" } as const;

function ChartTooltip({
  active,
  payload,
  label,
}: Partial<TooltipContentProps<number, string>>) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-neutral-200 bg-white/95 backdrop-blur px-3 py-2 shadow-lg text-xs min-w-[160px]">
      <div className="font-semibold text-neutral-900 mb-1.5">{label}</div>
      <div className="space-y-1">
        {payload.map((p, i) => {
          const swatch =
            (p.color as string | undefined) ||
            ((p as { stroke?: string }).stroke ?? "#94a3b8");
          return (
            <div key={`${String(p.dataKey)}-${i}`} className="flex items-center gap-2">
              <span
                className="inline-block w-2.5 h-2.5 rounded-[3px] shrink-0"
                style={{ background: swatch }}
              />
              <span className="text-neutral-600 truncate">{p.name}</span>
              <span className="ml-auto tabular-nums font-medium text-neutral-900">
                {fmt(p.value as number | undefined)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Legend({ items }: { items: { name: string; color: string }[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 px-1 text-[11px] text-neutral-600">
      {items.map((it) => (
        <span key={it.name} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: it.color }}
          />
          {it.name}
        </span>
      ))}
    </div>
  );
}

export default function MonthlyCharts({ months }: { months: MonthPoint[] }) {
  const rows = useMemo(() => toEurRows(months), [months]);
  // Only show stack legend entries that actually have data this year.
  const activeCats = useMemo(
    () =>
      CHART_CATEGORIES.filter((c) =>
        months.some((m) => (m.byCategory[c] ?? 0) > 0)
      ),
    [months]
  );

  const totalIncome = rows.reduce((s, r) => s + r.income, 0);
  const totalDeductible = rows.reduce((s, r) => s + r.totalDeductible, 0);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
      <Card
        title="Income vs deductible per month"
        subtitle={`Income ${fmt(totalIncome)} · Deductible ${fmt(totalDeductible)}`}
      >
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 14, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#f1f5f9" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="label"
                stroke="#cbd5e1"
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={false}
                dy={4}
              />
              <YAxis
                stroke="#cbd5e1"
                tick={AXIS_TICK}
                tickFormatter={fmt}
                tickLine={false}
                axisLine={false}
                width={64}
              />
              <Tooltip
                cursor={{ fill: "rgba(15, 23, 42, 0.04)" }}
                content={<ChartTooltip />}
              />
              <Bar
                dataKey="totalDeductible"
                name="Deductible"
                fill="#cbd5e1"
                radius={[6, 6, 0, 0]}
                maxBarSize={36}
                activeBar={{ fill: "#94a3b8" }}
                animationDuration={650}
                animationEasing="ease-out"
              />
              <Line
                type="monotone"
                dataKey="income"
                name="Income"
                stroke="var(--accent-600)"
                strokeWidth={2.25}
                dot={{ r: 3.5, fill: "var(--accent-600)", stroke: "#ffffff", strokeWidth: 2 }}
                activeDot={{ r: 5.5, fill: "var(--accent-600)", stroke: "#ffffff", strokeWidth: 2 }}
                animationDuration={800}
                animationEasing="ease-out"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <Legend
          items={[
            { name: "Income", color: "var(--accent-600)" },
            { name: "Deductible", color: "#94a3b8" },
          ]}
        />
      </Card>

      <Card
        title="Deductible breakdown by category"
        subtitle="Stacked across deductible categories"
      >
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 14, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#f1f5f9" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="label"
                stroke="#cbd5e1"
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={false}
                dy={4}
              />
              <YAxis
                stroke="#cbd5e1"
                tick={AXIS_TICK}
                tickFormatter={fmt}
                tickLine={false}
                axisLine={false}
                width={64}
              />
              <Tooltip
                cursor={{ fill: "rgba(15, 23, 42, 0.04)" }}
                content={<ChartTooltip />}
              />
              {activeCats.map((cat) => (
                <Bar
                  key={cat}
                  dataKey={cat}
                  stackId="ded"
                  name={CATEGORY_LABEL[cat]}
                  fill={CATEGORY_COLOR[cat]}
                  fillOpacity={0.92}
                  maxBarSize={36}
                  activeBar={{ fillOpacity: 1 }}
                  animationDuration={650}
                  animationEasing="ease-out"
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
        <Legend
          items={activeCats.map((c) => ({
            name: CATEGORY_LABEL[c],
            color: CATEGORY_COLOR[c],
          }))}
        />
      </Card>
    </div>
  );
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white shadow-sm">
      <div className="border-b border-neutral-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>
        {subtitle ? (
          <p className="mt-0.5 text-xs text-neutral-500 tabular-nums">{subtitle}</p>
        ) : null}
      </div>
      <div className="p-3 pb-3.5">{children}</div>
    </section>
  );
}
