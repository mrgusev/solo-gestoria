import { TREATMENT_RULES, formatIban, parseTreatments } from "@/lib/bank-accounts";

export type BankAccountFormValues = {
  id?: string;
  label: string;
  beneficiary: string;
  bankName: string;
  iban: string;
  swift: string;
  address: string;
  notes: string;
  defaultForTreatments: string | null;
  isDefault: boolean;
  useForAeat: boolean;
};

// Plain server-rendered form — nothing here reacts to typing, so it needs no
// client bundle. The exclusivity of the default/AEAT/treatment claims is
// enforced in the action, not by disabling inputs.
export default function BankAccountForm({
  action,
  initial,
  submitLabel,
  cancelHref,
  isOnlyAccount,
  issuerName,
}: {
  action: (formData: FormData) => void | Promise<void>;
  initial: BankAccountFormValues;
  submitLabel: string;
  cancelHref: string;
  // The first account is forced to be the default — there'd be no fallback
  // otherwise, so the checkbox is locked on.
  isOnlyAccount: boolean;
  issuerName: string;
}) {
  const claimed = parseTreatments(initial.defaultForTreatments);

  return (
    <form action={action} className="p-6 max-w-2xl space-y-6">
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}

      <Section title="Account">
        <Field
          name="label"
          label="Label"
          defaultValue={initial.label}
          required
          hint="Shown in the invoice picker only — never printed on the PDF."
        />
        <Field
          name="beneficiary"
          label="Beneficiary (optional)"
          defaultValue={initial.beneficiary}
          hint={`Account holder as the bank knows them. Blank prints "${issuerName}".`}
        />
        <Field name="bankName" label="Bank name" defaultValue={initial.bankName} required />
        <div className="grid grid-cols-2 gap-3">
          <Field
            name="iban"
            label="IBAN"
            defaultValue={initial.iban ? formatIban(initial.iban) : ""}
            required
            hint="Spaces are ignored."
          />
          <Field name="swift" label="SWIFT / BIC" defaultValue={initial.swift} required />
        </div>
        <Field
          name="address"
          label="Bank address (optional)"
          defaultValue={initial.address}
          multiline
        />
        <Field
          name="notes"
          label="Extra line (optional)"
          defaultValue={initial.notes}
          hint='Printed under the bank block, e.g. "Correspondent BIC: CHASDEFX".'
        />
      </Section>

      <Section title="When to use it">
        <fieldset>
          <legend className="text-sm font-medium text-neutral-700">
            Default for these clients
          </legend>
          <p className="mt-1 text-xs text-neutral-500">
            A new invoice for a client with one of these treatments is paid into this account.
            Each treatment belongs to one account — ticking it here takes it off the others.
          </p>
          <div className="mt-2 space-y-2">
            {TREATMENT_RULES.map((t) => (
              <label key={t.value} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="treatments"
                  value={t.value}
                  defaultChecked={claimed.includes(t.value)}
                  className="h-4 w-4 rounded border-neutral-300"
                />
                <span className="text-sm text-neutral-700">{t.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <Checkbox
          name="isDefault"
          label="Fallback account"
          defaultChecked={initial.isDefault || isOnlyAccount}
          readOnlyChecked={isOnlyAccount}
          hint="Used by every invoice no rule above claims. Exactly one account carries this."
        />
        <Checkbox
          name="useForAeat"
          label="Use for AEAT (modelo 303 / 130)"
          defaultChecked={initial.useForAeat || isOnlyAccount}
          hint="The IBAN written into the fichero for refunds and domiciliación."
        />
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
  "mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500";

function Field({
  name,
  label,
  defaultValue,
  type = "text",
  hint,
  required,
  multiline,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  type?: string;
  hint?: string;
  required?: boolean;
  multiline?: boolean;
}) {
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
          defaultValue={defaultValue}
          className={inputClass}
        />
      )}
      {hint ? <span className="mt-1 block text-xs text-neutral-500">{hint}</span> : null}
    </label>
  );
}

function Checkbox({
  name,
  label,
  defaultChecked,
  hint,
  readOnlyChecked,
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
  hint?: string;
  // A disabled checkbox submits nothing, so the locked-on case ships a hidden
  // field alongside it to keep the value in the FormData.
  readOnlyChecked?: boolean;
}) {
  return (
    <label className="block">
      <span className="flex items-center gap-2">
        <input
          name={readOnlyChecked ? undefined : name}
          type="checkbox"
          defaultChecked={defaultChecked}
          disabled={readOnlyChecked}
          className="h-4 w-4 rounded border-neutral-300"
        />
        {readOnlyChecked ? <input type="hidden" name={name} value="on" /> : null}
        <span className="text-sm font-medium text-neutral-700">{label}</span>
      </span>
      {hint ? <span className="mt-1 block text-xs text-neutral-500">{hint}</span> : null}
    </label>
  );
}
