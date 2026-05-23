"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";

const QUARTERS = [1, 2, 3, 4] as const;

export default function PeriodNav({
  year,
  quarter,
  years,
}: {
  year: number;
  quarter: 1 | 2 | 3 | 4;
  years: readonly number[];
}) {
  const router = useRouter();
  return (
    <div className="flex items-center gap-2">
      <select
        value={year}
        onChange={(e) => router.push(`/reports/${e.target.value}/${quarter}`)}
        className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
      >
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
      <div className="flex">
        {QUARTERS.map((q) => (
          <Link
            key={q}
            href={`/reports/${year}/${q}`}
            className={cn(
              "px-3 py-1 text-sm border",
              q === quarter
                ? "bg-accent-500 text-white border-accent-500"
                : "border-neutral-300 hover:bg-neutral-50",
              q === 1 ? "rounded-l-md" : "",
              q === 4 ? "rounded-r-md" : "",
              q > 1 ? "-ml-px" : ""
            )}
          >
            Q{q}
          </Link>
        ))}
      </div>
    </div>
  );
}
