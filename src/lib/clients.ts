// Client-side-safe helpers for the client (customer) records: the country
// list the forms offer and the tax-treatment presets each country implies.
// No prisma import — the "use client" forms pull from here too.

import type { VatTreatment } from "@prisma/client";

export const VAT_TREATMENTS: { value: VatTreatment; label: string; hint: string }[] = [
  {
    value: "DOMESTIC_ES",
    label: "Spanish client (IVA + IRPF)",
    hint: "IVA repercutido at the standard rate and retención de IRPF withheld by the client. Lands in MOD 303 boxes [07]/[08]/[09] and MOD 130 box [06].",
  },
  {
    value: "INTRA_EU_REVERSE_CHARGE",
    label: "EU business (reverse charge)",
    hint: "Exempt under art. 25 Ley 37/1992 — the customer self-assesses the VAT. Declared in MOD 303 box [59] and listed in MOD 349.",
  },
  {
    value: "EXPORT_NON_EU",
    label: "Non-EU business (export)",
    hint: "Outside the scope of Spanish VAT under the place-of-supply rules. Not reported in MOD 349.",
  },
];

// EU member states — the countries whose businesses go into MOD 349 under the
// reverse charge. (ES is a member but domestic sales are never in MOD 349.)
export const EU_COUNTRIES: { code: string; name: string }[] = [
  { code: "AT", name: "Austria" },
  { code: "BE", name: "Belgium" },
  { code: "BG", name: "Bulgaria" },
  { code: "HR", name: "Croatia" },
  { code: "CY", name: "Cyprus" },
  { code: "CZ", name: "Czechia" },
  { code: "DK", name: "Denmark" },
  { code: "EE", name: "Estonia" },
  { code: "FI", name: "Finland" },
  { code: "FR", name: "France" },
  { code: "DE", name: "Germany" },
  { code: "GR", name: "Greece" },
  { code: "HU", name: "Hungary" },
  { code: "IE", name: "Ireland" },
  { code: "IT", name: "Italy" },
  { code: "LV", name: "Latvia" },
  { code: "LT", name: "Lithuania" },
  { code: "LU", name: "Luxembourg" },
  { code: "MT", name: "Malta" },
  { code: "NL", name: "Netherlands" },
  { code: "PL", name: "Poland" },
  { code: "PT", name: "Portugal" },
  { code: "RO", name: "Romania" },
  { code: "SK", name: "Slovakia" },
  { code: "SI", name: "Slovenia" },
  { code: "ES", name: "Spain" },
  { code: "SE", name: "Sweden" },
];

const EU_CODES = new Set(EU_COUNTRIES.map((c) => c.code));

export function isEuCountry(code: string): boolean {
  return EU_CODES.has(code.toUpperCase());
}

// Common non-EU destinations, offered after the EU block. Any other country can
// be typed in — the form keeps a free-text fallback.
export const OTHER_COUNTRIES: { code: string; name: string }[] = [
  { code: "GB", name: "United Kingdom" },
  { code: "CH", name: "Switzerland" },
  { code: "NO", name: "Norway" },
  { code: "US", name: "United States" },
  { code: "CA", name: "Canada" },
  { code: "AU", name: "Australia" },
  { code: "AE", name: "United Arab Emirates" },
];

export const ALL_COUNTRIES = [...EU_COUNTRIES, ...OTHER_COUNTRIES];

export function countryName(code: string): string {
  return ALL_COUNTRIES.find((c) => c.code === code.toUpperCase())?.name ?? code;
}

// Spanish names for the same countries — the factura layout prints these so a
// domestic client reads "España", not "Spain". Keyed by ISO code.
const COUNTRY_NAMES_ES: Record<string, string> = {
  AT: "Austria",
  BE: "Bélgica",
  BG: "Bulgaria",
  HR: "Croacia",
  CY: "Chipre",
  CZ: "Chequia",
  DK: "Dinamarca",
  EE: "Estonia",
  FI: "Finlandia",
  FR: "Francia",
  DE: "Alemania",
  GR: "Grecia",
  HU: "Hungría",
  IE: "Irlanda",
  IT: "Italia",
  LV: "Letonia",
  LT: "Lituania",
  LU: "Luxemburgo",
  MT: "Malta",
  NL: "Países Bajos",
  PL: "Polonia",
  PT: "Portugal",
  RO: "Rumanía",
  SK: "Eslovaquia",
  SI: "Eslovenia",
  ES: "España",
  SE: "Suecia",
  GB: "Reino Unido",
  CH: "Suiza",
  NO: "Noruega",
  US: "Estados Unidos",
  CA: "Canadá",
  AU: "Australia",
  AE: "Emiratos Árabes Unidos",
};

// Takes either an ISO code or the English name — the client record stores a
// code, but Settings.issuerCountry is free text ("Spain"). Anything unknown
// (a hand-typed country outside the list) is passed through untouched.
export function countryNameES(codeOrName: string): string {
  const value = codeOrName.trim();
  const byCode = COUNTRY_NAMES_ES[value.toUpperCase()];
  if (byCode) return byCode;
  const match = ALL_COUNTRIES.find((c) => c.name.toLowerCase() === value.toLowerCase());
  return (match && COUNTRY_NAMES_ES[match.code]) ?? value;
}

// What a freshly picked country implies, used to pre-fill the form. The user
// can still override every field afterwards.
export function taxPresetForCountry(
  code: string,
  defaults: { vatRate: number; irpfRate: number }
): {
  vatTreatment: VatTreatment;
  vatRate: number;
  irpfRate: number;
  locale: "en" | "es";
} {
  const upper = code.toUpperCase();
  if (upper === "ES") {
    return {
      vatTreatment: "DOMESTIC_ES",
      vatRate: defaults.vatRate,
      irpfRate: defaults.irpfRate,
      locale: "es",
    };
  }
  return {
    vatTreatment: isEuCountry(upper) ? "INTRA_EU_REVERSE_CHARGE" : "EXPORT_NON_EU",
    vatRate: 0,
    irpfRate: 0,
    locale: "en",
  };
}

export function vatTreatmentLabel(t: VatTreatment): string {
  return VAT_TREATMENTS.find((v) => v.value === t)?.label ?? t;
}
