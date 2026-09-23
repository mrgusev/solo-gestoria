"use client";

import { useState } from "react";
import type { VatTreatment } from "@prisma/client";
import {
  ALL_COUNTRIES,
  EU_COUNTRIES,
  OTHER_COUNTRIES,
  VAT_TREATMENTS,
  countryName,
  taxPresetForCountry,
} from "@/lib/clients";

export type ClientFormValues = {
  id?: string;
  name: string;
  taxId: string;
  vatId: string;
  countryCode: string;
  country: string;
  addressLine: string;
  postalCode: string;
  city: string;
  province: string;
  email: string;
  notes: string;
  vatTreatment: VatTreatment;
  vatRatePct: number;
  irpfRatePct: number;
  invoiceLocale: string;
};

export default function ClientForm({
  action,
  initial,
  submitLabel,
  defaultVatRatePct,
  defaultIrpfRatePct,
  cancelHref,
}: {
  action: (formData: FormData) => void | Promise<void>;
  initial: ClientFormValues;
  submitLabel: string;
  // Settings-level defaults, used to pre-fill when the country is switched to ES.
  defaultVatRatePct: number;
  defaultIrpfRatePct: number;
  cancelHref: string;
}) {
  const [countryCode, setCountryCode] = useState(initial.countryCode);
  const [country, setCountry] = useState(initial.country);
  const [vatTreatment, setVatTreatment] = useState<VatTreatment>(initial.vatTreatment);
  const [vatRatePct, setVatRatePct] = useState(initial.vatRatePct);
  const [irpfRatePct, setIrpfRatePct] = useState(initial.irpfRatePct);
  const [invoiceLocale, setInvoiceLocale] = useState(initial.invoiceLocale);

  // Picking a country re-derives the whole tax block. Everything stays editable
  // afterwards — this only saves typing for the common cases.
  function onCountryChange(code: string) {
    setCountryCode(code);
    setCountry(countryName(code));
    const preset = taxPresetForCountry(code, {
      vatRate: defaultVatRatePct,
      irpfRate: defaultIrpfRatePct,
    });
    setVatTreatment(preset.vatTreatment);
    setVatRatePct(preset.vatRate);
    setIrpfRatePct(preset.irpfRate);
    setInvoiceLocale(preset.locale);
  }

  const domestic = vatTreatment === "DOMESTIC_ES";
  const treatmentHint = VAT_TREATMENTS.find((v) => v.value === vatTreatment)?.hint;

  return (
    <form action={action} className="p-6 max-w-2xl space-y-6">
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}

      <Section title="Identity">
        <Field name="name" label="Name" defaultValue={initial.name} required />
        <div className="grid grid-cols-2 gap-3">
          <Field
            name="taxId"
            label="Tax ID (NIF / CIF / reg. no.)"
            defaultValue={initial.taxId}
            hint={domestic ? "Required on a Spanish factura." : undefined}
          />
          <Field
            name="vatId"
            label="VAT ID"
            defaultValue={initial.vatId}
            hint={
              vatTreatment === "INTRA_EU_REVERSE_CHARGE"
                ? "With country prefix (e.g. EE102500628) — reported in MOD 349."
                : undefined
            }
          />
        </div>
        <Field name="email" label="Email" type="email" defaultValue={initial.email} />
      </Section>

      <Section title="Address">
        <label className="block">
          <span className="text-sm font-medium text-neutral-700">Country</span>
          <select
            value={countryCode}
            onChange={(e) => onCountryChange(e.target.value)}
            className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
          >
            <optgroup label="EU">
              {EU_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Other">
              {OTHER_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </optgroup>
            {ALL_COUNTRIES.some((c) => c.code === countryCode) ? null : (
              <option value={countryCode}>{countryCode}</option>
            )}
          </select>
        </label>
        <input type="hidden" name="countryCode" value={countryCode} />
        <Field
          name="country"
          label="Country name (as printed on the invoice)"
          value={country}
          onChange={setCountry}
        />
        <Field name="addressLine" label="Address" defaultValue={initial.addressLine} required />
        <div className="grid grid-cols-3 gap-3">
          <Field name="postalCode" label="Postal code" defaultValue={initial.postalCode} required />
          <Field name="city" label="City" defaultValue={initial.city} required />
          <Field
            name="province"
            label="Province"
            defaultValue={initial.province}
            hint={domestic ? "Shown on Spanish facturas." : undefined}
          />
        </div>
      </Section>

      <Section title="Tax treatment">
        <label className="block">
          <span className="text-sm font-medium text-neutral-700">VAT treatment</span>
          <select
            name="vatTreatment"
            value={vatTreatment}
            onChange={(e) => setVatTreatment(e.target.value as VatTreatment)}
            className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
          >
            {VAT_TREATMENTS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          {treatmentHint ? (
            <span className="mt-1 block text-xs text-neutral-500">{treatmentHint}</span>
          ) : null}
        </label>

        <div className="grid grid-cols-2 gap-3">
          <NumberField
            name="vatRatePct"
            label="IVA rate (%)"
            value={vatRatePct}
            onChange={setVatRatePct}
            step="0.01"
            disabled={!domestic}
            hint={domestic ? "21 general · 10 reducido · 4 superreducido." : "Exempt — no IVA charged."}
          />
          <NumberField
            name="irpfRatePct"
            label="IRPF retention (%)"
            value={irpfRatePct}
            onChange={setIrpfRatePct}
            step="0.01"
            disabled={!domestic}
            hint={
              domestic
                ? "15 standard · 7 during the first 3 years of activity."
                : "Only Spanish clients withhold IRPF."
            }
          />
        </div>

        <label className="block">
          <span className="text-sm font-medium text-neutral-700">Invoice language</span>
          <select
            name="invoiceLocale"
            value={invoiceLocale}
            onChange={(e) => setInvoiceLocale(e.target.value)}
            className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
          >
            <option value="es">Español (FACTURA)</option>
            <option value="en">English (INVOICE)</option>
          </select>
          <span className="mt-1 block text-xs text-neutral-500">
            Picks the PDF template. Each invoice keeps the language it was issued with.
          </span>
        </label>

        <Field name="notes" label="Notes" defaultValue={initial.notes} multiline />
      </Section>

      <div className="flex items-center gap-2 pt-2">
        <button
          type="submit"
          className="rounded-md bg-accent-500 px-4 py-2 text-sm font-medium text-white hover:bg-accent-600"
        >
          {submitLabel}
        </button>
        <a
          href={cancelHref}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
        >
          Cancel
        </a>
      </div>
    </form>
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

const inputClass =
  "mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500 disabled:bg-neutral-100 disabled:text-neutral-500";

function Field({
  name,
  label,
  defaultValue,
  value,
  onChange,
  type = "text",
  hint,
  required,
  multiline,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  value?: string;
  onChange?: (v: string) => void;
  type?: string;
  hint?: string;
  required?: boolean;
  multiline?: boolean;
}) {
  const controlled = value !== undefined;
  return (
    <label className="block">
      <span className="text-sm font-medium text-neutral-700">{label}</span>
      {multiline ? (
        <textarea name={name} defaultValue={defaultValue} rows={2} className={inputClass} />
      ) : (
        <input
          name={name}
          type={type}
          required={required}
          className={inputClass}
          {...(controlled
            ? { value, onChange: (e) => onChange?.(e.target.value) }
            : { defaultValue })}
        />
      )}
      {hint ? <span className="mt-1 block text-xs text-neutral-500">{hint}</span> : null}
    </label>
  );
}

function NumberField({
  name,
  label,
  value,
  onChange,
  step,
  hint,
  disabled,
}: {
  name: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-neutral-700">{label}</span>
      <input
        name={name}
        type="number"
        step={step}
        min={0}
        max={100}
        disabled={disabled}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.valueAsNumber)}
        className={inputClass}
      />
      {hint ? <span className="mt-1 block text-xs text-neutral-500">{hint}</span> : null}
    </label>
  );
}
