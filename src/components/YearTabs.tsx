import Link from "next/link";
import { cn } from "@/lib/cn";

export default function YearTabs({
  years,
  current,
  basePath,
}: {
  years: readonly number[];
  current: number;
  basePath: string; // e.g. "/" — appends `?year=` query
}) {
  if (years.length <= 1) return null;
  return (
    <div className="flex">
      {years.map((y, idx) => (
        <Link
          key={y}
          href={`${basePath}?year=${y}`}
          className={cn(
            "px-3 py-1 text-sm border",
            y === current
              ? "bg-accent-500 text-white border-accent-500"
              : "border-neutral-300 hover:bg-neutral-50",
            idx === 0 ? "rounded-l-md" : "",
            idx === years.length - 1 ? "rounded-r-md" : "",
            idx > 0 ? "-ml-px" : ""
          )}
        >
          {y}
        </Link>
      ))}
    </div>
  );
}
