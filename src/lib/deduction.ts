import type { ExpenseCategory, Settings } from "@prisma/client";

// IRPF rules for home-office expenses (Spanish autónomos):
//
// 1. Suministros (utilities — electricity, gas, water, internet, phone)
//    Art. 30.5.b Ley 35/2006 (modified by Ley 6/2017): "30% de los gastos
//    de suministros, proporcionales a los metros cuadrados de la vivienda
//    dedicados a la actividad". Effective rate = 30% × area%.
//
// 2. Other gastos de titularidad de la vivienda (rent, mortgage interest,
//    IBI, comunidad, basuras, seguro): just area% — no 30% multiplier.
//
// 3. Both are only deductible from the date the local-affecto declaration
//    (modelo 036/037 alta of "local indirectamente afecto") took effect.
const UTILITY_LEGAL_RATE = 30; // %, fixed by Ley 35/2006 art. 30.5.b

export function utilityDeductiblePct(settings: Settings): number {
  // Two-decimal precision — Math.round at cent application time keeps amounts integer.
  return Math.round((UTILITY_LEGAL_RATE * settings.homeOfficePct) / 100 * 100) / 100;
}

export function rentDeductiblePct(settings: Settings): number {
  return settings.homeOfficePct;
}

// True if this date is on or after the home-office alta date. Pre-alta
// dates can't claim any home-office deduction.
function homeOfficeEligible(settings: Settings, expenseDate?: Date | null): boolean {
  if (!settings.homeOfficeStartDate) return true; // not set → assume always eligible
  if (!expenseDate) return false;                  // unknown date → safer to refuse
  return expenseDate.getTime() >= settings.homeOfficeStartDate.getTime();
}

export function defaultDeductiblePct(
  category: ExpenseCategory,
  settings: Settings,
  expenseDate?: Date | null
): number {
  switch (category) {
    case "UTILITY_ELECTRICITY":
    case "UTILITY_INTERNET":
    case "UTILITY_WATER":
    case "UTILITY_GAS":
      return homeOfficeEligible(settings, expenseDate) ? utilityDeductiblePct(settings) : 0;
    case "RENT_HOUSING":
      return homeOfficeEligible(settings, expenseDate) ? rentDeductiblePct(settings) : 0;
    case "SOCIAL_SECURITY":
    case "GESTORIA":
    case "SOFTWARE":
    case "BANK_FEES":
    case "OTHER_DEDUCTIBLE":
      return 100;
    case "NON_DEDUCTIBLE":
      return 0;
    default:
      return 0;
  }
}

export function applyDeduction(
  pct: number,
  netCents: number,
  vatCents: number
): { deductibleNetCents: number; deductibleVatCents: number } {
  const clamped = Math.max(0, Math.min(100, pct));
  return {
    deductibleNetCents: Math.round((netCents * clamped) / 100),
    deductibleVatCents: Math.round((vatCents * clamped) / 100),
  };
}
