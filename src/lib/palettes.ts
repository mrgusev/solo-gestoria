// Accent palette presets. Each palette is a full 50→900 scale that drives the
// --accent-* CSS variables (see src/app/globals.css and the runtime <style>
// injector in src/app/layout.tsx).
//
// To add a palette: append an entry below, then it appears automatically in
// the Settings picker. To retune the default, change `DEFAULT_PALETTE` or edit
// the `coral` entry — every bg-accent-*/text-accent-*/border-accent-* utility
// in the app picks the change up.

export type PaletteName =
  | "coral"
  | "indigo"
  | "emerald"
  | "rose"
  | "amber"
  | "slate";

export type PaletteScale = {
  50: string;
  100: string;
  200: string;
  300: string;
  400: string;
  500: string;
  600: string;
  700: string;
  800: string;
  900: string;
};

export const PALETTES: Record<PaletteName, PaletteScale> = {
  coral: {
    50: "#fff4ee",
    100: "#ffe6d6",
    200: "#ffc7a8",
    300: "#ffa379",
    400: "#ff7f50",
    500: "#ff6235",
    600: "#e44a1f",
    700: "#b73818",
    800: "#8f2c14",
    900: "#6b2210",
  },
  indigo: {
    50: "#eef2ff",
    100: "#e0e7ff",
    200: "#c7d2fe",
    300: "#a5b4fc",
    400: "#818cf8",
    500: "#6366f1",
    600: "#4f46e5",
    700: "#4338ca",
    800: "#3730a3",
    900: "#312e81",
  },
  emerald: {
    50: "#ecfdf5",
    100: "#d1fae5",
    200: "#a7f3d0",
    300: "#6ee7b7",
    400: "#34d399",
    500: "#10b981",
    600: "#059669",
    700: "#047857",
    800: "#065f46",
    900: "#064e3b",
  },
  rose: {
    50: "#fff1f2",
    100: "#ffe4e6",
    200: "#fecdd3",
    300: "#fda4af",
    400: "#fb7185",
    500: "#f43f5e",
    600: "#e11d48",
    700: "#be123c",
    800: "#9f1239",
    900: "#881337",
  },
  amber: {
    50: "#fffbeb",
    100: "#fef3c7",
    200: "#fde68a",
    300: "#fcd34d",
    400: "#fbbf24",
    500: "#f59e0b",
    600: "#d97706",
    700: "#b45309",
    800: "#92400e",
    900: "#78350f",
  },
  slate: {
    50: "#f8fafc",
    100: "#f1f5f9",
    200: "#e2e8f0",
    300: "#cbd5e1",
    400: "#94a3b8",
    500: "#475569",
    600: "#334155",
    700: "#1e293b",
    800: "#0f172a",
    900: "#020617",
  },
};

export const PALETTE_NAMES = Object.keys(PALETTES) as PaletteName[];

export const DEFAULT_PALETTE: PaletteName = "coral";

export function resolvePalette(name: string | null | undefined): PaletteScale {
  if (name && name in PALETTES) return PALETTES[name as PaletteName];
  return PALETTES[DEFAULT_PALETTE];
}

// Render a `:root { --accent-50: …; … }` rule for the given palette.
// Used in the root layout to override globals.css defaults at request time.
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

export function paletteCss(scale: PaletteScale): string {
  const lines = SHADES.map((k) => `--accent-${k}:${scale[k]}`).join(";");
  return `:root{${lines}}`;
}
