"use client";

import { useMemo, useState } from "react";
import { submitInvoice } from "./actions";

type ClientOption = { id: string; name: string };

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return isoDate(dt);
}

export default function InvoiceForm({
  defaultDate,
  defaultDueDate,
  defaultHours,
  defaultRate,
  defaultDescription,
  vatExempt,
  clients,
  defaultClientId,
}: {
  defaultDate: string;        // YYYY-MM-DD
  defaultDueDate: string;     // YYYY-MM-DD
  defaultHours: number;
  defaultRate: number;        // EUR per hour
  defaultDescription: string;
  vatExempt: boolean;
  clients: ClientOption[];
  defaultClientId: string;
}) {
  const [hours, setHours] = useState(defaultHours);
  const [rate, setRate] = useState(defaultRate);
  const [date, setDate] = useState(defaultDate);
  const [dueDate, setDueDate] = useState(defaultDueDate);
  // Track whether the user has explicitly edited the due date; if not, keep
  // it +30 days in sync with the invoice date.
  const [dueDateTouched, setDueDateTouched] = useState(false);

  const totals = useMemo(() => {
    const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 0;
    const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 0;
    const subtotal = Math.round(safeHours * safeRate * 100) / 100;
    const vatRate = vatExempt ? 0 : 0.21;
    const vat = Math.round(subtotal * vatRate * 100) / 100;
    return { subtotal, vat, vatRate, total: subtotal + vat };
  }, [hours, rate, vatExempt]);

  function onDateChange(newDate: string) {
    setDate(newDate);
    if (!dueDateTouched && newDate) {
      setDueDate(addDaysISO(newDate, 30));
    }
  }

  return (
    <form action={submitInvoice} className="p-6 max-w-xl space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm font-medium">Invoice date</span>
          <input
            name="date"
            type="date"
            required
            value={date}
            onChange={(e) => onDateChange(e.target.value)}
            className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
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
            className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
          />
        </label>
      </div>

      <label className="block">
        <span className="text-sm font-medium">Hours</span>
        <input
          name="hours"
          type="number"
          step="0.25"
          min="0"
          required
          value={Number.isFinite(hours) ? hours : ""}
          onChange={(e) => setHours(e.target.valueAsNumber)}
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium">Hourly rate (€)</span>
        <input
          name="hourlyRate"
          type="number"
          step="0.01"
          min="0"
          value={Number.isFinite(rate) ? rate : ""}
          onChange={(e) => setRate(e.target.valueAsNumber)}
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
      </label>

      <TotalPreview {...totals} vatExempt={vatExempt} />

      <label className="block">
        <span className="text-sm font-medium">Line description</span>
        <input
          name="description"
          type="text"
          defaultValue={defaultDescription}
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium">Client</span>
        <select
          name="clientId"
          defaultValue={defaultClientId}
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
        >
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      <div className="pt-2">
        <button
          type="submit"
          disabled={!(hours > 0) || !(rate > 0) || !date || !dueDate}
          className="rounded-md bg-accent-500 px-4 py-2 text-sm font-medium text-white hover:bg-accent-600 disabled:bg-neutral-400 disabled:cursor-not-allowed"
        >
          Create invoice
        </button>
      </div>
    </form>
  );
}

function TotalPreview({
  subtotal,
  vat,
  vatRate,
  total,
  vatExempt,
}: {
  subtotal: number;
  vat: number;
  vatRate: number;
  total: number;
  vatExempt: boolean;
}) {
  return (
    <div className="rounded-md border border-neutral-200 bg-neutral-50 p-4">
      <Row label="Subtotal" value={subtotal} bold={false} />
      <Row
        label={`VAT ${(vatRate * 100).toFixed(0)}%${vatExempt ? " ¹ (exempt)" : ""}`}
        value={vat}
        bold={false}
      />
      <div className="mt-2 border-t border-neutral-200 pt-2">
        <Row label="Invoice total" value={total} bold />
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: number; bold: boolean }) {
  return (
    <div className="flex justify-between text-sm">
      <span className={bold ? "font-semibold" : "text-neutral-600"}>{label}</span>
      <span className={`tabular-nums ${bold ? "font-semibold" : ""}`}>{formatEUR(value)}</span>
    </div>
  );
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
