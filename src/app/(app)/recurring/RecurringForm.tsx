"use client";

import { useMemo, useState } from "react";
import type { RecurringFrequency, VatTreatment } from "@prisma/client";
import { computeInvoiceTotals, pctToRate } from "@/lib/invoice-totals";
import { formatIban, pickBankAccountFor } from "@/lib/bank-accounts";
import type { EditorBankAccountOption, SerializedLine } from "@/components/InvoiceEditor";

export type RecurringClientOption = {
  id: string;
  name: string;
  email: string;
  vatTreatment: VatTreatment;
  vatRatePct: number;
  irpfRatePct: number;
};

export type RecurringFormLine = {
  description: string;
  quantity: number;
  unit: string;
  unitPriceEur: number;
  vatRatePct: number;
};

type Row = RecurringFormLine & { key: string };

let rowSeq = 0;
function newKey(): string {
  rowSeq += 1;
  return `row-${rowSeq}`;
}

function formatEUR(value: number): string {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: "always",
  }).format(value);
}

const FREQUENCIES: { value: RecurringFrequency; label: string }[] = [
  { value: "MONTHLY", label: "Monthly" },
  { value: "QUARTERLY", label: "Every 3 months" },
  { value: "YEARLY", label: "Yearly" },
];

// Create/edit form for a standing billing instruction. The line table mirrors
// the invoice editor — same SerializedLine blob, same server-side zod parse —
// because a schedule is just an invoice template plus a cadence.
export default function RecurringForm({
  action,
  scheduleId,
  clients,
  bankAccounts,
  initial,
  submitLabel,
  cancelHref,
}: {
  action: (formData: FormData) => void | Promise<void>;
  scheduleId?: string;
  clients: RecurringClientOption[];
  bankAccounts: EditorBankAccountOption[];
  initial: {
    name: string;
    clientId: string;
    active: boolean;
    frequency: RecurringFrequency;
    dayOfMonth: number;
    dueDays: number;
    startDate: string;
    endDate: string;
    emailTo: string;
    emailCc: string;
    notes: string;
    lines: RecurringFormLine[];
    irpfRatePct: number;
    // "" leaves it on automatic — each issued invoice then resolves the
    // account from the client's treatment at that moment.
    bankAccountId: string;
  };
  submitLabel: string;
  cancelHref?: string;
}) {
  const [name, setName] = useState(initial.name);
  const [clientId, setClientId] = useState(initial.clientId);
  const [bankAccountId, setBankAccountId] = useState(initial.bankAccountId);
  const [frequency, setFrequency] = useState<RecurringFrequency>(initial.frequency);
  const [dayOfMonth, setDayOfMonth] = useState(initial.dayOfMonth);
  const [dueDays, setDueDays] = useState(initial.dueDays);
  const [irpfRatePct, setIrpfRatePct] = useState(initial.irpfRatePct);
  const [rows, setRows] = useState<Row[]>(initial.lines.map((l) => ({ ...l, key: newKey() })));

  const client = clients.find((c) => c.id === clientId);
  const domestic = client?.vatTreatment === "DOMESTIC_ES";

  const totals = useMemo(
    () =>
      computeInvoiceTotals(
        rows.map((r) => ({
          quantity: Number.isFinite(r.quantity) ? r.quantity : 0,
          unitPriceCents: Number.isFinite(r.unitPriceEur) ? Math.round(r.unitPriceEur * 100) : 0,
          vatRate: pctToRate(r.vatRatePct),
        })),
        pctToRate(irpfRatePct)
      ),
    [rows, irpfRatePct]
  );

  const serialized: SerializedLine[] = rows.map((r) => ({
    description: r.description,
    quantity: Number.isFinite(r.quantity) ? r.quantity : 0,
    unit: r.unit,
    unitPriceCents: Number.isFinite(r.unitPriceEur) ? Math.round(r.unitPriceEur * 100) : 0,
    vatRate: pctToRate(r.vatRatePct),
  }));

  const autoAccount = client ? pickBankAccountFor(bankAccounts, client.vatTreatment) : null;
  const selectedAccount =
    bankAccounts.find((a) => a.id === bankAccountId) ??
    (bankAccountId === "" ? autoAccount : null);

  const valid =
    name.trim() !== "" &&
    clientId !== "" &&
    rows.length > 0 &&
    rows.every((r) => r.description.trim() !== "" && r.quantity > 0);

  function onClientChange(id: string) {
    setClientId(id);
    const next = clients.find((c) => c.id === id);
    if (!next) return;
    setIrpfRatePct(next.irpfRatePct);
    setRows((prev) => prev.map((r) => ({ ...r, vatRatePct: next.vatRatePct })));
  }

  function updateRow(key: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((prev) => [
      ...prev,
      {
        key: newKey(),
        description: "",
        quantity: 1,
        unit: "ud",
        unitPriceEur: 0,
        vatRatePct: client?.vatRatePct ?? 0,
      },
    ]);
  }

  function removeRow(key: string) {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.key !== key)));
  }

  return (
    <form action={action} className="p-6 max-w-3xl space-y-4">
      {scheduleId ? <input type="hidden" name="id" value={scheduleId} /> : null}
      <input type="hidden" name="lines" value={JSON.stringify(serialized)} />
      <input type="hidden" name="irpfRatePct" value={String(irpfRatePct)} />

      <label className="block">
        <span className="text-sm font-medium">Name</span>
        <input
          name="name"
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme monthly retainer"
          className={inputClass}
        />
        <span className="mt-1 block text-xs text-neutral-500">
          Only for your own reference — it never appears on the invoice.
        </span>
      </label>

      <label className="block">
        <span className="text-sm font-medium">Client</span>
        <select
          name="clientId"
          value={clientId}
          onChange={(e) => onClientChange(e.target.value)}
          className={inputClass}
        >
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-neutral-500">
          {client?.email
            ? `Invoices go to ${client.email} unless you override it below.`
            : "⚠️ This client has no email address — add one, or set a recipient below."}
        </span>
      </label>

      <label className="block">
        <span className="text-sm font-medium">Paid into</span>
        <select
          name="bankAccountId"
          value={bankAccountId}
          onChange={(e) => setBankAccountId(e.target.value)}
          className={inputClass}
        >
          <option value="">
            {autoAccount ? `Automatic — ${autoAccount.label}` : "Automatic"}
          </option>
          {bankAccounts
            .filter((a) => !a.archived || a.id === bankAccountId)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
                {a.archived ? " (archived)" : ""}
              </option>
            ))}
        </select>
        <span className="mt-1 block text-xs text-neutral-500">
          {selectedAccount
            ? `${selectedAccount.label} · ${formatIban(selectedAccount.iban)} — printed on every invoice this schedule issues.`
            : "No bank accounts configured — invoices fall back to the legacy details in Settings."}
        </span>
      </label>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="block">
          <span className="text-sm font-medium">Frequency</span>
          <select
            name="frequency"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as RecurringFrequency)}
            className={inputClass}
          >
            {FREQUENCIES.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-sm font-medium">Issue on day</span>
          <input
            name="dayOfMonth"
            type="number"
            min="1"
            max="31"
            required
            value={Number.isFinite(dayOfMonth) ? dayOfMonth : ""}
            onChange={(e) => setDayOfMonth(e.target.valueAsNumber)}
            className={inputClass}
          />
          <span className="mt-1 block text-xs text-neutral-500">
            {dayOfMonth > 28 ? "Short months fall back to their last day." : " "}
          </span>
        </label>
        <label className="block">
          <span className="text-sm font-medium">Payment terms (days)</span>
          <input
            name="dueDays"
            type="number"
            min="0"
            max="365"
            required
            value={Number.isFinite(dueDays) ? dueDays : ""}
            onChange={(e) => setDueDays(e.target.valueAsNumber)}
            className={inputClass}
          />
        </label>
        <label className="flex items-center gap-2 pt-6">
          <input
            name="active"
            type="checkbox"
            defaultChecked={initial.active}
            className="h-4 w-4 rounded border-neutral-300"
          />
          <span className="text-sm font-medium">Active</span>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm font-medium">First invoice</span>
          <input
            name="startDate"
            type="date"
            required
            defaultValue={initial.startDate}
            className={inputClass}
          />
          <span className="mt-1 block text-xs text-neutral-500">
            The cadence counts from this month. A date in the past only backfills the last 45 days.
          </span>
        </label>
        <label className="block">
          <span className="text-sm font-medium">Stop after (optional)</span>
          <input
            name="endDate"
            type="date"
            defaultValue={initial.endDate}
            className={inputClass}
          />
          <span className="mt-1 block text-xs text-neutral-500">
            Leave empty to bill until you deactivate it.
          </span>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm font-medium">Send to (optional)</span>
          <input
            name="emailTo"
            type="text"
            defaultValue={initial.emailTo}
            placeholder={client?.email || "billing@client.com"}
            className={inputClass}
          />
          <span className="mt-1 block text-xs text-neutral-500">
            Comma-separated. Overrides the client&apos;s address.
          </span>
        </label>
        <label className="block">
          <span className="text-sm font-medium">Cc (optional)</span>
          <input name="emailCc" type="text" defaultValue={initial.emailCc} className={inputClass} />
        </label>
      </div>

      <div className="rounded-md border border-neutral-200 bg-white">
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2.5">
          <h2 className="text-sm font-medium">Lines billed each time</h2>
          <button
            type="button"
            onClick={addRow}
            className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
          >
            + Add line
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-3 py-2">Description</th>
                <th className="px-3 py-2 w-24">Qty</th>
                <th className="px-3 py-2 w-20">Unit</th>
                <th className="px-3 py-2 w-28">Price (€)</th>
                <th className="px-3 py-2 w-24">IVA %</th>
                <th className="px-3 py-2 w-28 text-right">Net</th>
                <th className="px-3 py-2 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const net =
                  Math.round(
                    (Number.isFinite(r.quantity) ? r.quantity : 0) *
                      (Number.isFinite(r.unitPriceEur) ? r.unitPriceEur * 100 : 0)
                  ) / 100;
                return (
                  <tr key={r.key} className="border-t border-neutral-200 align-top">
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={r.description}
                        onChange={(e) => updateRow(r.key, { description: e.target.value })}
                        className={cellClass}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        step="0.25"
                        min="0"
                        value={Number.isFinite(r.quantity) ? r.quantity : ""}
                        onChange={(e) => updateRow(r.key, { quantity: e.target.valueAsNumber })}
                        className={cellClass}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        maxLength={10}
                        value={r.unit}
                        onChange={(e) => updateRow(r.key, { unit: e.target.value })}
                        className={cellClass}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={Number.isFinite(r.unitPriceEur) ? r.unitPriceEur : ""}
                        onChange={(e) => updateRow(r.key, { unitPriceEur: e.target.valueAsNumber })}
                        className={cellClass}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        max="100"
                        disabled={!domestic}
                        value={Number.isFinite(r.vatRatePct) ? r.vatRatePct : ""}
                        onChange={(e) => updateRow(r.key, { vatRatePct: e.target.valueAsNumber })}
                        className={cellClass}
                      />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatEUR(net)}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => removeRow(r.key)}
                        disabled={rows.length <= 1}
                        title={rows.length <= 1 ? "A schedule needs at least one line" : "Remove line"}
                        className="rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {domestic ? (
        <label className="block max-w-xs">
          <span className="text-sm font-medium">IRPF retention (%)</span>
          <input
            type="number"
            step="0.01"
            min="0"
            max="100"
            value={Number.isFinite(irpfRatePct) ? irpfRatePct : ""}
            onChange={(e) => setIrpfRatePct(e.target.valueAsNumber)}
            className={inputClass}
          />
        </label>
      ) : null}

      <label className="block">
        <span className="text-sm font-medium">Invoice notes (optional)</span>
        <textarea name="notes" rows={2} defaultValue={initial.notes} className={inputClass} />
      </label>

      <div className="rounded-md border border-neutral-200 bg-neutral-50 p-4 max-w-sm ml-auto">
        <TotalRow label="Base imponible" value={totals.subtotalCents / 100} />
        {totals.vatByRate.length === 0 ? (
          <TotalRow label="IVA 0% (exempt)" value={0} />
        ) : (
          totals.vatByRate.map((g) => (
            <TotalRow
              key={g.rate}
              label={`IVA ${Math.round(g.rate * 10000) / 100}%`}
              value={g.cuotaCents / 100}
            />
          ))
        )}
        {totals.irpfCents > 0 ? (
          <TotalRow
            label={`Retención IRPF ${Math.round(pctToRate(irpfRatePct) * 10000) / 100}%`}
            value={-totals.irpfCents / 100}
          />
        ) : null}
        <div className="mt-2 border-t border-neutral-200 pt-2">
          <TotalRow label="Each invoice" value={totals.totalCents / 100} bold />
        </div>
      </div>

      <div className="flex items-center gap-2 pt-2">
        <button
          type="submit"
          disabled={!valid}
          className="rounded-md bg-accent-500 px-4 py-2 text-sm font-medium text-white hover:bg-accent-600 disabled:bg-neutral-400 disabled:cursor-not-allowed"
        >
          {submitLabel}
        </button>
        {cancelHref ? (
          <a
            href={cancelHref}
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            Cancel
          </a>
        ) : null}
      </div>
    </form>
  );
}

const inputClass =
  "mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500";

const cellClass =
  "block w-full rounded-md border border-neutral-300 px-2 py-1 text-sm focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500 disabled:bg-neutral-100 disabled:text-neutral-500";

function TotalRow({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className="flex justify-between text-sm">
      <span className={bold ? "font-semibold" : "text-neutral-600"}>{label}</span>
      <span className={`tabular-nums ${bold ? "font-semibold" : ""}`}>{formatEUR(value)}</span>
    </div>
  );
}
