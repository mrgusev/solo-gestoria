// Client-safe shared definitions used by both the server-side aggregator
// (`src/lib/dashboard.ts`) and the client chart component. Keeping these in
// a separate file ensures the prisma/better-sqlite3 dependency tree doesn't
// leak into the browser bundle.
import type { ExpenseCategory } from "@prisma/client";

export const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

export const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  UTILITY_ELECTRICITY: "Electricity",
  UTILITY_INTERNET: "Internet",
  UTILITY_WATER: "Water",
  UTILITY_GAS: "Gas",
  RENT_HOUSING: "Rent",
  SOCIAL_SECURITY: "Social security",
  GESTORIA: "Gestoría",
  SOFTWARE: "Software",
  BANK_FEES: "Bank fees",
  OTHER_DEDUCTIBLE: "Other deductible",
  NON_DEDUCTIBLE: "Non-deductible",
};

export const CATEGORY_COLOR: Record<ExpenseCategory, string> = {
  UTILITY_ELECTRICITY: "#f59e0b",
  UTILITY_INTERNET: "#0ea5e9",
  UTILITY_WATER: "#06b6d4",
  UTILITY_GAS: "#f97316",
  RENT_HOUSING: "#a855f7",
  SOCIAL_SECURITY: "#ef4444",
  GESTORIA: "#10b981",
  SOFTWARE: "#3b82f6",
  BANK_FEES: "#6b7280",
  OTHER_DEDUCTIBLE: "#84cc16",
  NON_DEDUCTIBLE: "#d1d5db",
};

export type MonthPoint = {
  monthIndex: number;
  label: string;
  incomeCents: number;
  totalDeductibleCents: number;
  byCategory: Partial<Record<ExpenseCategory, number>>;
};
