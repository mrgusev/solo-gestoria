import PageHeader from "@/components/PageHeader";
import { prisma } from "@/lib/db";
import { eur } from "@/lib/money";
import { ensureRetaExpensesForYear } from "@/lib/reta";
import { utilityDeductiblePct } from "@/lib/deduction";
import { recomputeAllExpenseDeductions } from "@/lib/recompute";
import { PALETTE_NAMES, PALETTES, DEFAULT_PALETTE } from "@/lib/palettes";
import { revalidatePath } from "next/cache";

async function updateSettings(formData: FormData): Promise<void> {
  "use server";
  const homeOfficePct = Number(formData.get("homeOfficePct") ?? 30);
  const retaEur = Number(formData.get("retaMonthlyCuotaEur") ?? 0);
  const hourlyEur = Number(formData.get("defaultHourlyRateEur") ?? 0);
  const lineDesc = String(formData.get("defaultLineDescription") ?? "");
  const exemption = String(formData.get("vatExemptionFootnote") ?? "");
  const invoiceYear = Number(formData.get("invoiceNumberYear") ?? new Date().getFullYear());
  const invoiceSeq = Number(formData.get("invoiceNumberSeq") ?? 1);
  const telegramBotTokenRaw = String(formData.get("telegramBotToken") ?? "").trim();
  const telegramChatIds = String(formData.get("telegramAllowedChatIds") ?? "").trim();
  const accentPaletteRaw = String(formData.get("accentPalette") ?? DEFAULT_PALETTE);
  const accentPalette = (PALETTE_NAMES as string[]).includes(accentPaletteRaw)
    ? accentPaletteRaw
    : DEFAULT_PALETTE;

  await prisma.settings.update({
    where: { id: 1 },
    data: {
      homeOfficePct: clamp(homeOfficePct, 0, 100),
      retaMonthlyCuotaCents: Math.round(retaEur * 100),
      defaultHourlyRateCents: Math.round(hourlyEur * 100),
      defaultLineDescription: lineDesc,
      vatExemptionFootnote: exemption,
      invoiceNumberYear: invoiceYear,
      invoiceNumberSeq: invoiceSeq,
      accentPalette,
      // Empty token submission means "keep existing" — never wipe the token by accident.
      ...(telegramBotTokenRaw.length > 0 ? { telegramBotToken: telegramBotTokenRaw } : {}),
      telegramAllowedChatIds: telegramChatIds.length > 0 ? telegramChatIds : null,
    },
  });
  await ensureRetaExpensesForYear(new Date().getUTCFullYear());
  // Re-apply category-driven deduction rules to all confirmed expenses so
  // changes to homeOfficePct propagate to historical utility bills.
  await recomputeAllExpenseDeductions();
  // "layout" scope on "/" revalidates the root layout — needed so the
  // accent-palette <style> tag is re-emitted with the new selection.
  revalidatePath("/", "layout");
  revalidatePath("/settings");
  revalidatePath("/expenses");
  revalidatePath("/reports", "layout");
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

export default async function SettingsPage() {
  const s = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!s) {
    return (
      <>
        <PageHeader title="Settings" />
        <div className="p-6 text-sm text-red-600">
          Settings not initialized. Run <code>npm run db:seed</code>.
        </div>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Settings"
        description="Issuer details, defaults, and deduction rules."
      />
      <form action={updateSettings} className="p-6 max-w-2xl space-y-6">
        <Section title="Bookkeeping defaults">
          <Field
            name="homeOfficePct"
            label="Business-use area of home (%)"
            type="number"
            defaultValue={String(s.homeOfficePct)}
            min={0}
            max={100}
            hint={`The % of your home's m² declared to Hacienda as used for the activity. Spanish law (art. 30.5.b Ley 35/2006) lets you deduct 30% of utility bills proportional to this area — currently ${utilityDeductiblePct(s)}% of each electricity, internet, water, and gas bill (net + VAT) at your ${s.homeOfficePct}% area.`}
          />
          <Field
            name="retaMonthlyCuotaEur"
            label="RETA monthly cuota (€)"
            type="number"
            step="0.01"
            defaultValue={eur(s.retaMonthlyCuotaCents).toFixed(2)}
            hint="100% IRPF-deductible. Auto-creates one SOCIAL_SECURITY expense per month."
          />
          <Field
            name="defaultHourlyRateEur"
            label="Default hourly rate (€)"
            type="number"
            step="0.01"
            defaultValue={eur(s.defaultHourlyRateCents).toFixed(2)}
          />
          <Field
            name="defaultLineDescription"
            label="Default invoice line description"
            defaultValue={s.defaultLineDescription}
          />
          <Field
            name="vatExemptionFootnote"
            label="VAT-exempt footnote text"
            defaultValue={s.vatExemptionFootnote}
            multiline
          />
        </Section>

        <Section title="Invoice numbering">
          <div className="grid grid-cols-2 gap-3">
            <Field
              name="invoiceNumberYear"
              label="Year"
              type="number"
              defaultValue={String(s.invoiceNumberYear)}
            />
            <Field
              name="invoiceNumberSeq"
              label="Next sequence"
              type="number"
              defaultValue={String(s.invoiceNumberSeq)}
              hint={`Next invoice number: FACT-${s.invoiceNumberYear}-${String(s.invoiceNumberSeq).padStart(5, "0")}`}
            />
          </div>
        </Section>

        <Section title="Appearance">
          <label className="block">
            <span className="text-sm font-medium">Accent palette</span>
            <select
              name="accentPalette"
              defaultValue={s.accentPalette}
              className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
            >
              {PALETTE_NAMES.map((name) => (
                <option key={name} value={name}>
                  {name[0].toUpperCase() + name.slice(1)}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-neutral-500">
              Drives buttons, active tabs, and focus rings across the app. Changes apply after saving.
            </p>
          </label>
          <div className="flex flex-wrap gap-3 pt-1">
            {PALETTE_NAMES.map((name) => {
              const scale = PALETTES[name];
              const active = s.accentPalette === name;
              return (
                <div
                  key={name}
                  className={`rounded-md border px-2 py-1.5 text-[11px] ${
                    active ? "border-neutral-400 bg-neutral-50" : "border-neutral-200"
                  }`}
                >
                  <div className="flex items-center gap-1">
                    <span className="h-3 w-3 rounded" style={{ background: scale[300] }} />
                    <span className="h-3 w-3 rounded" style={{ background: scale[500] }} />
                    <span className="h-3 w-3 rounded" style={{ background: scale[700] }} />
                  </div>
                  <div className="mt-0.5 text-neutral-600">{name}</div>
                </div>
              );
            })}
          </div>
        </Section>

        <Section title="Telegram bot">
          <Field
            name="telegramBotToken"
            label="Bot token (from @BotFather)"
            type="password"
            defaultValue=""
            hint={
              s.telegramBotToken
                ? `Stored (••••${s.telegramBotToken.slice(-4)}). Leave blank to keep, or paste a new token to replace.`
                : "Get one by messaging @BotFather → /newbot. The token is stored in the local SQLite DB only."
            }
          />
          <Field
            name="telegramAllowedChatIds"
            label="Allowed chat IDs"
            defaultValue={s.telegramAllowedChatIds ?? ""}
            hint="Comma-separated Telegram user IDs that the bot will respond to. Get yours from @userinfobot."
          />
          <p className="text-xs text-neutral-500">
            Start the worker with{" "}
            <code className="rounded bg-neutral-100 px-1 py-0.5">npm run bot</code> in a
            separate terminal. The bot accepts text messages and PDF expense receipts.
          </p>
        </Section>

        <Section title="Issuer (read-only)">
          <ReadField label="Name" value={s.issuerName} />
          <ReadField label="NIF" value={s.issuerTaxId} />
          <ReadField label="VAT ID" value={s.issuerVatId} />
          <ReadField
            label="Address"
            value={`${s.issuerAddressLine}, ${s.issuerPostalCode} ${s.issuerCity}, ${s.issuerCountry}`}
          />
          <ReadField label="IBAN" value={s.bankIban} />
          <ReadField label="SWIFT" value={s.bankSwift} />
          <p className="text-xs text-neutral-500">
            Edit via{" "}
            <code className="rounded bg-neutral-100 px-1 py-0.5">prisma/seed.ts</code>{" "}
            and re-run <code className="rounded bg-neutral-100 px-1 py-0.5">npm run db:seed</code>{" "}
            for now.
          </p>
        </Section>

        <div className="pt-2">
          <button
            type="submit"
            className="rounded-md bg-accent-500 px-4 py-2 text-sm font-medium text-white hover:bg-accent-600"
          >
            Save settings
          </button>
        </div>
      </form>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-neutral-200 bg-white">
      <div className="border-b border-neutral-200 px-4 py-2.5">
        <h2 className="text-sm font-medium">{title}</h2>
      </div>
      <div className="p-4 space-y-4">{children}</div>
    </section>
  );
}

function Field({
  name,
  label,
  defaultValue,
  type = "text",
  step,
  min,
  max,
  hint,
  multiline,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  type?: string;
  step?: string;
  min?: number;
  max?: number;
  hint?: string;
  multiline?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-neutral-700">{label}</span>
      {multiline ? (
        <textarea
          name={name}
          defaultValue={defaultValue}
          rows={3}
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
        />
      ) : (
        <input
          name={name}
          type={type}
          step={step}
          min={min}
          max={max}
          defaultValue={defaultValue}
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
        />
      )}
      {hint ? <span className="mt-1 block text-xs text-neutral-500">{hint}</span> : null}
    </label>
  );
}

function ReadField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  );
}
