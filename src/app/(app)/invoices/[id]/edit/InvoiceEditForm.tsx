"use client";

import { useMemo, useState } from "react";
import { submitInvoiceEdit } from "./actions";

type ClientOption = { id: string; name: string };

export default function InvoiceEditForm(props: {
  invoiceId: string;
  defaultDate: string;
  defaultDueDate: string;
  defaultHours: number;
  defaultRate: number;
  defaultDescription: string;
  defaultClientId: string;
  vatExempt: boolean;
  clients: ClientOption[];
}) {
  const [hours, setHours] = useState(props.defaultHours);
  const [rate, setRate] = useState(props.defaultRate);
  const [date, setDate] = useState(props.defaultDate);
  const [dueDate, setDueDate] = useState(props.defaultDueDate);

  const totals = useMemo(() => {
    const h = Number.isFinite(hours) && hours > 0 ? hours : 0;
    const r = Number.isFinite(rate) && rate > 0 ? rate : 0;
    const subtotal = Math.round(h * r * 100) / 100;
    const vatRate = props.vatExempt ? 0 : 0.21;
    const vat = Math.round(subtotal * vatRate * 100) / 100;
    return { subtotal, vat, vatRate, total: subtotal + vat };
  }, [hours, rate, props.vatExempt]);

  return (
    <form action={submitInvoiceEdit} className="p-6 max-w-xl space-y-4">
      <input type="hidden" name="id" value={props.invoiceId} />
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm font-medium">Invoice date</span>
          <input
            name="date"
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
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
            onChange={(e) => setDueDate(e.target.value)}
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

      <div className="rounded-md border border-neutral-200 bg-neutral-50 p-4">
        <Row label="Subtotal" value={totals.subtotal} bold={false} />
        <Row
          label={`VAT ${(totals.vatRate * 100).toFixed(0)}%${props.vatExempt ? " ¹ (exempt)" : ""}`}
          value={totals.vat}
          bold={false}
        />
        <div className="mt-2 border-t border-neutral-200 pt-2">
          <Row label="Invoice total" value={totals.total} bold />
        </div>
      </div>

      <label className="block">
        <span className="text-sm font-medium">Line description</span>
        <input
          name="description"
          type="text"
          defaultValue={props.defaultDescription}
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium">Client</span>
        <select
          name="clientId"
          defaultValue={props.defaultClientId}
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
        >
          {props.clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      <div className="pt-2 flex items-center gap-2">
        <button
          type="submit"
          disabled={!(hours > 0) || !(rate > 0) || !date || !dueDate}
          className="rounded-md bg-coral-500 px-4 py-2 text-sm font-medium text-white hover:bg-coral-600 disabled:bg-neutral-400 disabled:cursor-not-allowed"
        >
          Save changes
        </button>
        <a
          href={`/invoices/${props.invoiceId}`}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
        >
          Cancel
        </a>
      </div>
    </form>
  );
}

function Row({ label, value, bold }: { label: string; value: number; bold: boolean }) {
  return (
    <div className="flex justify-between text-sm">
      <span className={bold ? "font-semibold" : "text-neutral-600"}>{label}</span>
      <span className={`tabular-nums ${bold ? "font-semibold" : ""}`}>
        {new Intl.NumberFormat("es-ES", {
          style: "currency",
          currency: "EUR",
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
          useGrouping: "always",
        }).format(value)}
      </span>
    </div>
  );
}
