"use client";

import { useMemo, useState } from "react";
import type { VatTreatment } from "@prisma/client";
import { computeInvoiceTotals, pctToRate } from "@/lib/invoice-totals";
import { formatIban, pickBankAccountFor } from "@/lib/bank-accounts";

// The picker only needs enough of a BankAccount to resolve and label it.
export type EditorBankAccountOption = {
  id: string;
  label: string;
  iban: string;
  defaultForTreatments: string | null;
  isDefault: boolean;
  archived: boolean;
};

export type EditorClientOption = {
  id: string;
  name: string;
  vatTreatment: VatTreatment;
  vatRatePct: number;
  irpfRatePct: number;
};

export type EditorLine = {
  description: string;
  quantity: number;
  unit: string;
  unitPriceEur: number;
  vatRatePct: number;
};

type Row = EditorLine & { key: string };

// Serialized shape of one line in the hidden `lines` field. The server action
// parses this back with zod — see the invoice `actions.ts` files.
export type SerializedLine = {
  description: string;
  quantity: number;
  unit: string;
  unitPriceCents: number;
  vatRate: number;
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return isoDate(dt);
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

let rowSeq = 0;
function newKey(): string {
  rowSeq += 1;
  return `row-${rowSeq}`;
}

// Shared create/edit invoice form. Lines are edited client-side and submitted
// as one JSON blob so the row count can vary freely.
export default function InvoiceEditor({
  action,
  invoiceId,
  clients,
  bankAccounts,
  initialDate,
  initialDueDate,
  initialClientId,
  initialLines,
  initialIrpfRatePct,
  initialBankAccountId,
  submitLabel,
  cancelHref,
  syncDueDate = false,
  defaultLineDescription,
  defaultUnitPriceEur,
}: {
  action: (formData: FormData) => void | Promise<void>;
  invoiceId?: string;
  clients: EditorClientOption[];
  bankAccounts: EditorBankAccountOption[];
  initialDate: string;
  initialDueDate: string;
  initialClientId: string;
  initialLines: EditorLine[];
  initialIrpfRatePct: number;
  // "" means "whatever the client's treatment resolves to at save time".
  initialBankAccountId: string;
  submitLabel: string;
  cancelHref?: string;
  // On a new invoice, keep the due date at +30 days until the user edits it.
  syncDueDate?: boolean;
  defaultLineDescription: string;
  defaultUnitPriceEur: number;
}) {
  const [date, setDate] = useState(initialDate);
  const [dueDate, setDueDate] = useState(initialDueDate);
  const [dueDateTouched, setDueDateTouched] = useState(false);
  const [clientId, setClientId] = useState(initialClientId);
  const [irpfRatePct, setIrpfRatePct] = useState(initialIrpfRatePct);
  const [bankAccountId, setBankAccountId] = useState(initialBankAccountId);
  const [rows, setRows] = useState<Row[]>(
    initialLines.map((l) => ({ ...l, key: newKey() }))
  );

  const client = clients.find((c) => c.id === clientId);
  const domestic = client?.vatTreatment === "DOMESTIC_ES";

  // What leaving the picker on "automatic" would resolve to — same rule the
  // server applies on save, so the hint can't disagree with the PDF.
  const autoAccount = client ? pickBankAccountFor(bankAccounts, client.vatTreatment) : null;
  const selectedAccount =
    bankAccounts.find((a) => a.id === bankAccountId) ?? (bankAccountId === "" ? autoAccount : null);

  const totals = useMemo(
    () =>
      computeInvoiceTotals(
        rows.map((r) => ({
          quantity: Number.isFinite(r.quantity) ? r.quantity : 0,
          unitPriceCents: Number.isFinite(r.unitPriceEur)
            ? Math.round(r.unitPriceEur * 100)
            : 0,
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

  const valid =
    date !== "" &&
    dueDate !== "" &&
    clientId !== "" &&
    rows.length > 0 &&
    rows.every((r) => r.description.trim() !== "" && r.quantity > 0);

  function onDateChange(newDate: string) {
    setDate(newDate);
    if (syncDueDate && !dueDateTouched && newDate) setDueDate(addDaysISO(newDate, 30));
  }

  // Switching client re-applies that client's tax treatment to every line —
  // an invoice can't mix treatments, so the whole document follows.
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
        description: defaultLineDescription,
        quantity: 1,
        unit: "ud",
        unitPriceEur: defaultUnitPriceEur,
        vatRatePct: client?.vatRatePct ?? 0,
      },
    ]);
  }

  function removeRow(key: string) {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.key !== key)));
  }

  return (
    <form action={action} className="p-6 max-w-3xl space-y-4">
      {invoiceId ? <input type="hidden" name="id" value={invoiceId} /> : null}
      <input type="hidden" name="lines" value={JSON.stringify(serialized)} />
      <input type="hidden" name="irpfRatePct" value={String(irpfRatePct)} />

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm font-medium">Invoice date</span>
          <input
            name="date"
            type="date"
            required
            value={date}
            onChange={(e) => onDateChange(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Due date</span>
          <input
            name="dueDate"
            type="date"
            required
            value={dueDate}
            onChange={(e) => {
              setDueDateTouched(true);
              setDueDate(e.target.value);
            }}
            className={inputClass}
          />
        </label>
      </div>

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
          {domestic
            ? `Spanish client — IVA ${client?.vatRatePct ?? 0}% repercutido, ${client?.irpfRatePct ?? 0}% IRPF withheld.`
            : client?.vatTreatment === "EXPORT_NON_EU"
              ? "Non-EU client — not subject to Spanish VAT."
              : "EU business — VAT reverse-charged to the customer (MOD 349)."}
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
            ? `${selectedAccount.label} · ${formatIban(selectedAccount.iban)} — printed in the PDF footer.`
            : "No bank accounts configured — the PDF falls back to the legacy details in Settings."}
        </span>
      </label>

      <div className="rounded-md border border-neutral-200 bg-white">
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2.5">
          <h2 className="text-sm font-medium">Lines</h2>
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
                        title={rows.length <= 1 ? "An invoice needs at least one line" : "Remove line"}
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
          <span className="mt-1 block text-xs text-neutral-500">
            Withheld by the client and paid to Hacienda on your behalf. Reduces MOD 130 box [06].
          </span>
        </label>
      ) : null}

      <div className="rounded-md border border-neutral-200 bg-neutral-50 p-4 max-w-sm ml-auto">
        <Row label="Base imponible" value={totals.subtotalCents / 100} />
        {totals.vatByRate.length === 0 ? (
          <Row label="IVA 0% (exempt)" value={0} />
        ) : (
          totals.vatByRate.map((g) => (
            <Row
              key={g.rate}
              label={`IVA ${Math.round(g.rate * 10000) / 100}%`}
              value={g.cuotaCents / 100}
            />
          ))
        )}
        {totals.irpfCents > 0 ? (
          <Row
            label={`Retención IRPF ${Math.round(pctToRate(irpfRatePct) * 10000) / 100}%`}
            value={-totals.irpfCents / 100}
          />
        ) : null}
        <div className="mt-2 border-t border-neutral-200 pt-2">
          <Row label="Invoice total" value={totals.totalCents / 100} bold />
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

function Row({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className="flex justify-between text-sm">
      <span className={bold ? "font-semibold" : "text-neutral-600"}>{label}</span>
      <span className={`tabular-nums ${bold ? "font-semibold" : ""}`}>{formatEUR(value)}</span>
    </div>
  );
}
