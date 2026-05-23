// All amounts are integer cents at rest. Display helpers below.

export const cents = (eur: number): number => Math.round(eur * 100);
export const eur = (c: number): number => c / 100;

export function formatEUR(c: number): string {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: "always",
  }).format(c / 100);
}

export function formatNumberES(value: number, digits = 2): string {
  return new Intl.NumberFormat("es-ES", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: "always",
  }).format(value);
}

export function formatDateISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}
