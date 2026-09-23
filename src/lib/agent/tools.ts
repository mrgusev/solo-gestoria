import { z } from "zod";
import { prisma } from "../db";
import { renderInvoicePdf } from "../invoice-pdf";
import { createMonthlyInvoice, previewNextInvoiceNumber } from "../invoice";
import { pctToRate, rateToPct } from "../invoice-totals";
import { taxPresetForCountry, countryName } from "../clients";
import { listBankAccounts, resolveAeatIban } from "../bank-accounts-db";
import { computeQuarterReport, quarterOf, type Quarter } from "../tax";
import { recomputeAllExpenseDeductions } from "../recompute";
import * as tg from "../telegram";
import { EXPENSE_CATEGORIES } from "../expense-parser";
import { createPending } from "./pending";
import {
  describeUpdateExpense,
  describeDeleteExpense,
  describeUpdateInvoice,
  describeDeleteInvoice,
} from "./mutations";

// Context passed to every tool. Includes the Telegram chat the agent is
// currently talking to so tools like sendInvoicePdf know where to deliver.
export type ToolContext = {
  chatId: number;
  telegramToken: string;
};

// All amounts in returned data are integers (cents) so the agent doesn't
// have to do floating-point math. The system prompt tells it that.

const QuarterParam = z
  .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
  .describe("Calendar quarter, 1-4");
const YearParam = z
  .number()
  .int()
  .min(2000)
  .max(2100)
  .describe("Year, 4-digit");

// ---- Tool definitions ----

const tools = [
  defineTool({
    name: "get_current_date",
    description:
      "Get today's date in YYYY-MM-DD format (UTC). Also returns the current year and quarter. Use this before answering questions involving 'this quarter', 'this year', 'today', 'now'.",
    parameters: z.object({}),
    handler: async () => {
      const now = new Date();
      return {
        date: now.toISOString().slice(0, 10),
        year: now.getUTCFullYear(),
        quarter: quarterOf(now),
        month: now.getUTCMonth() + 1,
      };
    },
  }),

  defineTool({
    name: "get_settings",
    description:
      "Get the user's current bookkeeping settings: home-office area %, RETA monthly cuota, default hourly rate, default line description, issuer details.",
    parameters: z.object({}),
    handler: async () => {
      const s = await prisma.settings.findUnique({ where: { id: 1 } });
      if (!s) throw new Error("Settings not initialised");
      const accounts = await listBankAccounts();
      return {
        issuerName: s.issuerName,
        issuerTaxId: s.issuerTaxId,
        issuerVatId: s.issuerVatId,
        issuerAddress: `${s.issuerAddressLine}, ${s.issuerPostalCode} ${s.issuerCity}, ${s.issuerCountry}`,
        homeOfficePct: s.homeOfficePct,
        homeOfficeStartDate: s.homeOfficeStartDate?.toISOString().slice(0, 10) ?? null,
        retaMonthlyCuotaCents: s.retaMonthlyCuotaCents,
        defaultHourlyRateCents: s.defaultHourlyRateCents,
        defaultLineDescription: s.defaultLineDescription,
        bankAccounts: accounts.map((a) => ({
          id: a.id,
          label: a.label,
          iban: a.iban,
          defaultFor: a.defaultForTreatments,
          isFallback: a.isDefault,
        })),
        aeatIban: await resolveAeatIban(s),
      };
    },
  }),

  defineTool({
    name: "get_quarter_stats",
    description:
      "Get the full quarterly tax breakdown (MOD 130 / 303 / 349 box values) for a given year + quarter. Returns income, deductible base, deductible VAT, and the IRPF payment owed in this quarter.",
    parameters: z.object({ year: YearParam, quarter: QuarterParam }),
    handler: async ({ year, quarter }) => {
      const r = await computeQuarterReport(year, quarter);
      return {
        year,
        quarter,
        incomeCents: r.period.incomeCents,
        deductibleNetCents: r.period.deductibleNetCents,
        deductibleVatCents: r.period.deductibleVatCents,
        ytdIncomeCents: r.ytd.incomeCents,
        ytdDeductibleCents: r.ytd.deductibleNetCents,
        mod130: r.mod130,
        mod303: r.mod303,
        mod349: r.mod349,
      };
    },
  }),

  defineTool({
    name: "get_year_summary",
    description:
      "Per-quarter and per-month summary of income and deductible amounts for a year. Use for 'how was my year', 'monthly breakdown', annual recap questions.",
    parameters: z.object({ year: YearParam }),
    handler: async ({ year }) => {
      const start = new Date(Date.UTC(year, 0, 1));
      const endExclusive = new Date(Date.UTC(year + 1, 0, 1));
      const [invoices, expenses] = await Promise.all([
        prisma.invoice.findMany({
          where: { date: { gte: start, lt: endExclusive } },
          // Income = base imponible, matching the dashboard and MOD 130 [01].
          select: { date: true, subtotalCents: true },
        }),
        prisma.expense.findMany({
          where: { status: "CONFIRMED", date: { gte: start, lt: endExclusive } },
          select: { date: true, category: true, deductibleNetCents: true, deductibleVatCents: true },
        }),
      ]);

      const monthly: Array<{ month: number; incomeCents: number; deductibleCents: number }> = [];
      for (let m = 0; m < 12; m++) {
        monthly.push({ month: m + 1, incomeCents: 0, deductibleCents: 0 });
      }
      for (const inv of invoices) monthly[inv.date.getUTCMonth()].incomeCents += inv.subtotalCents;
      for (const e of expenses) {
        monthly[e.date.getUTCMonth()].deductibleCents +=
          e.deductibleNetCents + e.deductibleVatCents;
      }
      const totalIncome = monthly.reduce((s, m) => s + m.incomeCents, 0);
      const totalDeductible = monthly.reduce((s, m) => s + m.deductibleCents, 0);

      const quarterly = ([1, 2, 3, 4] as Quarter[]).map((q) => {
        const months = monthly.slice((q - 1) * 3, q * 3);
        return {
          quarter: q,
          incomeCents: months.reduce((s, m) => s + m.incomeCents, 0),
          deductibleCents: months.reduce((s, m) => s + m.deductibleCents, 0),
        };
      });

      return { year, totalIncomeCents: totalIncome, totalDeductibleCents: totalDeductible, monthly, quarterly };
    },
  }),

  defineTool({
    name: "list_invoices",
    description:
      "List invoices, optionally filtered by year and quarter. Returns id, number, date, client name, base/VAT/IRPF/total and the VAT treatment. Default limit 20.",
    parameters: z.object({
      year: YearParam.optional(),
      quarter: QuarterParam.optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    handler: async ({ year, quarter, limit }) => {
      const where: { date?: { gte: Date; lt: Date } } = {};
      if (year != null) {
        const qStart = quarter ? (quarter - 1) * 3 : 0;
        const qEnd = quarter ? quarter * 3 : 12;
        where.date = {
          gte: new Date(Date.UTC(year, qStart, 1)),
          lt: new Date(Date.UTC(year, qEnd, 1)),
        };
      }
      const rows = await prisma.invoice.findMany({
        where,
        orderBy: { date: "desc" },
        take: limit ?? 20,
        include: { client: { select: { name: true } } },
      });
      return rows.map((r) => ({
        id: r.id,
        number: r.number,
        date: r.date.toISOString().slice(0, 10),
        dueDate: r.dueDate.toISOString().slice(0, 10),
        client: r.client.name,
        subtotalCents: r.subtotalCents,
        vatCents: r.vatCents,
        irpfCents: r.irpfCents,
        totalCents: r.totalCents,
        vatTreatment: r.vatTreatment,
        vatExempt: r.vatExempt,
      }));
    },
  }),

  defineTool({
    name: "get_invoice",
    description: "Get full invoice details (lines, totals) by ID or number.",
    parameters: z.object({
      idOrNumber: z.string().describe("Invoice id (cuid) or invoice number like 'FACT-2025-00007'"),
    }),
    handler: async ({ idOrNumber }) => {
      const inv = await prisma.invoice.findFirst({
        where: { OR: [{ id: idOrNumber }, { number: idOrNumber }] },
        include: { lines: { orderBy: { position: "asc" } }, client: true },
      });
      if (!inv) throw new Error(`Invoice ${idOrNumber} not found`);
      return {
        id: inv.id,
        number: inv.number,
        date: inv.date.toISOString().slice(0, 10),
        dueDate: inv.dueDate.toISOString().slice(0, 10),
        client: inv.client.name,
        clientVatId: inv.client.vatId,
        subtotalCents: inv.subtotalCents,
        vatCents: inv.vatCents,
        irpfCents: inv.irpfCents,
        irpfRate: inv.irpfRate,
        totalCents: inv.totalCents,
        vatTreatment: inv.vatTreatment,
        vatExempt: inv.vatExempt,
        lines: inv.lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unit: l.unit,
          unitPriceCents: l.unitPriceCents,
          vatRate: l.vatRate,
          netCents: l.netCents,
        })),
      };
    },
  }),

  defineTool({
    name: "preview_next_invoice_number",
    description: "What invoice number would be assigned next for the given year. Use to tell the user before they confirm creation.",
    parameters: z.object({ year: YearParam.optional() }),
    handler: async ({ year }) => previewNextInvoiceNumber(year),
  }),

  defineTool({
    name: "create_invoice",
    description:
      "Create a new single-line invoice (hours x rate). Date is the invoice issue date (YYYY-MM-DD). dueDate defaults to date + 30 days. hourlyRate is optional (defaults to settings.defaultHourlyRate). description is optional. clientId defaults to settings.defaultClientId. IVA and IRPF are taken from the client's tax treatment — only pass vatRatePct/irpfRatePct to override them for this one invoice. The payment account is likewise chosen from the client's treatment; only pass bankAccountId (see get_settings) when the user asks to be paid into a specific account. For multi-line invoices, direct the user to /invoices/new in the web UI. Returns the created invoice id + number.",
    parameters: z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      hours: z.number().positive(),
      hourlyRateEur: z.number().positive().optional(),
      description: z.string().optional(),
      clientId: z.string().optional(),
      vatRatePct: z.number().min(0).max(100).optional(),
      irpfRatePct: z.number().min(0).max(100).optional(),
      bankAccountId: z.string().optional(),
    }),
    handler: async ({
      date,
      dueDate,
      hours,
      hourlyRateEur,
      description,
      clientId,
      vatRatePct,
      irpfRatePct,
      bankAccountId,
    }) => {
      const issueDate = parseDate(date);
      const due = dueDate ? parseDate(dueDate) : addDays(issueDate, 30);
      const inv = await createMonthlyInvoice({
        date: issueDate,
        dueDate: due,
        hours,
        hourlyRateCents: hourlyRateEur != null ? Math.round(hourlyRateEur * 100) : undefined,
        description,
        clientId,
        vatRate: vatRatePct != null ? pctToRate(vatRatePct) : undefined,
        irpfRate: irpfRatePct != null ? pctToRate(irpfRatePct) : undefined,
        bankAccountId,
      });
      return inv;
    },
  }),

  defineTool({
    name: "send_invoice_pdf",
    description:
      "Generate the invoice PDF and send it to the user via Telegram as a document attachment. Use this after creating an invoice or when the user asks for the PDF.",
    parameters: z.object({
      idOrNumber: z.string(),
      caption: z.string().optional(),
    }),
    handler: async ({ idOrNumber, caption }, ctx) => {
      const [invoice, settings] = await Promise.all([
        prisma.invoice.findFirst({
          where: { OR: [{ id: idOrNumber }, { number: idOrNumber }] },
          include: { lines: true, client: true, bankAccount: true },
        }),
        prisma.settings.findUnique({ where: { id: 1 } }),
      ]);
      if (!invoice) throw new Error(`Invoice ${idOrNumber} not found`);
      if (!settings) throw new Error("Settings missing");
      const pdf = await renderInvoicePdf({ invoice, settings });
      const sent = await tg.sendDocument(
        ctx.telegramToken,
        ctx.chatId,
        pdf,
        `${invoice.number}.pdf`,
        { caption: caption ?? `Invoice ${invoice.number}` }
      );
      return { sent: true, telegramMessageId: sent.message_id };
    },
  }),

  defineTool({
    name: "list_expenses",
    description:
      "List expenses, optionally filtered by year, quarter, category, or status. Returns id, date, vendor, category, gross, deductible. Default limit 30.",
    parameters: z.object({
      year: YearParam.optional(),
      quarter: QuarterParam.optional(),
      category: z.enum(EXPENSE_CATEGORIES).optional(),
      status: z.enum(["PENDING_REVIEW", "CONFIRMED"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    handler: async ({ year, quarter, category, status, limit }) => {
      const where: {
        date?: { gte: Date; lt: Date };
        category?: typeof category;
        status?: typeof status;
      } = {};
      if (year != null) {
        const qStart = quarter ? (quarter - 1) * 3 : 0;
        const qEnd = quarter ? quarter * 3 : 12;
        where.date = {
          gte: new Date(Date.UTC(year, qStart, 1)),
          lt: new Date(Date.UTC(year, qEnd, 1)),
        };
      }
      if (category) where.category = category;
      if (status) where.status = status;
      const rows = await prisma.expense.findMany({
        where,
        orderBy: { date: "desc" },
        take: limit ?? 30,
      });
      return rows.map((e) => ({
        id: e.id,
        date: e.date.toISOString().slice(0, 10),
        vendor: e.vendor,
        category: e.category,
        grossCents: e.grossCents,
        netCents: e.netCents,
        vatCents: e.vatCents,
        deductiblePct: e.deductiblePct,
        deductibleNetCents: e.deductibleNetCents,
        deductibleVatCents: e.deductibleVatCents,
        status: e.status,
        source: e.source,
      }));
    },
  }),

  defineTool({
    name: "get_expense",
    description: "Get full expense details (including notes and parsed extraction) by id.",
    parameters: z.object({ id: z.string() }),
    handler: async ({ id }) => {
      const e = await prisma.expense.findUnique({ where: { id } });
      if (!e) throw new Error(`Expense ${id} not found`);
      return {
        ...e,
        date: e.date.toISOString().slice(0, 10),
        createdAt: e.createdAt.toISOString(),
        updatedAt: e.updatedAt.toISOString(),
      };
    },
  }),

  defineTool({
    name: "update_expense",
    description:
      "Propose an update to an expense. THIS DOES NOT APPLY THE CHANGE — it sends a confirmation card to the user's Telegram chat with Apply/Cancel buttons. The mutation only executes when the user taps Apply. " +
      "Fields you can change: category, deductiblePct, vendor, notes, date, grossEur, netEur, vatEur, vatRate, confirm. " +
      "After calling this tool, DO NOT call it again for the same expense in the same turn. Stop and tell the user to confirm via the buttons.",
    parameters: z.object({
      id: z.string(),
      category: z.enum(EXPENSE_CATEGORIES).optional(),
      deductiblePct: z.number().min(0).max(100).optional(),
      vendor: z.string().optional(),
      notes: z.string().optional(),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("YYYY-MM-DD"),
      grossEur: z.number().nonnegative().optional().describe("Total amount in euros (gross, including VAT)"),
      netEur: z.number().nonnegative().optional().describe("Net base in euros (excluding VAT)"),
      vatEur: z.number().nonnegative().optional().describe("VAT amount in euros"),
      vatRate: z.number().min(0).max(1).optional().describe("VAT rate as a fraction, e.g. 0.21"),
      confirm: z.boolean().optional().describe("Mark a PENDING_REVIEW expense as CONFIRMED."),
    }),
    handler: async (args, ctx) => {
      const { summary } = await describeUpdateExpense(args);
      const pendingId = createPending({
        type: "update_expense",
        chatId: ctx.chatId,
        args: args as Record<string, unknown>,
        summary,
      });
      await tg.sendMessage(ctx.telegramToken, ctx.chatId, summary, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Apply", callback_data: `pending:apply:${pendingId}` },
              { text: "✕ Cancel", callback_data: `pending:cancel:${pendingId}` },
            ],
          ],
        },
      });
      return {
        pending: true,
        pendingId,
        note: "Awaiting user confirmation in the chat. Do NOT retry update_expense for this entry until the user confirms or cancels. End your turn with a brief message telling the user to confirm above.",
      };
    },
  }),

  defineTool({
    name: "delete_expense",
    description:
      "Propose deletion of an expense. THIS DOES NOT DELETE — it sends a confirmation card to the chat. The expense is removed only when the user taps Apply.",
    parameters: z.object({ id: z.string() }),
    handler: async ({ id }, ctx) => {
      const { summary } = await describeDeleteExpense(id);
      const pendingId = createPending({
        type: "delete_expense",
        chatId: ctx.chatId,
        args: { id },
        summary,
      });
      await tg.sendMessage(ctx.telegramToken, ctx.chatId, summary, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🗑️ Delete", callback_data: `pending:apply:${pendingId}` },
              { text: "✕ Cancel", callback_data: `pending:cancel:${pendingId}` },
            ],
          ],
        },
      });
      return {
        pending: true,
        pendingId,
        note: "Awaiting user confirmation in the chat. The expense will NOT be deleted unless the user taps Delete on the card above.",
      };
    },
  }),

  defineTool({
    name: "update_invoice",
    description:
      "Propose an update to an invoice (date, dueDate, hours, hourlyRate, description, clientId). THIS DOES NOT APPLY — sends a confirmation card. " +
      "REFUSED if the invoice is locked: invoices lock automatically once their quarter's MOD 303 filing deadline passes " +
      "(Q1→Apr 21, Q2→Jul 21, Q3→Oct 21, Q4→Jan 31). After that, the user must issue a factura rectificativa instead. " +
      "The FACT-YYYY-NNNNN number cannot be changed.",
    parameters: z.object({
      id: z.string().describe("Invoice id (cuid) or number like 'FACT-2026-00003'"),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      hours: z.number().positive().optional(),
      hourlyRateEur: z.number().positive().optional(),
      description: z.string().optional(),
      clientId: z.string().optional(),
    }),
    handler: async (args, ctx) => {
      // Resolve number → id if needed.
      let realId = args.id;
      if (/^FACT-/.test(args.id)) {
        const inv = await prisma.invoice.findUnique({ where: { number: args.id } });
        if (!inv) throw new Error(`Invoice ${args.id} not found`);
        realId = inv.id;
      }
      const argsResolved = { ...args, id: realId };
      const { summary, locked, lockReason } = await describeUpdateInvoice(argsResolved);
      if (locked) {
        return {
          pending: false,
          error: "invoice_locked",
          message: `Cannot update — ${lockReason ?? "invoice is locked"}. Tell the user to issue a factura rectificativa instead.`,
        };
      }
      const pendingId = createPending({
        type: "update_invoice",
        chatId: ctx.chatId,
        args: argsResolved as unknown as Record<string, unknown>,
        summary,
      });
      await tg.sendMessage(ctx.telegramToken, ctx.chatId, summary, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Apply", callback_data: `pending:apply:${pendingId}` },
              { text: "✕ Cancel", callback_data: `pending:cancel:${pendingId}` },
            ],
          ],
        },
      });
      return {
        pending: true,
        pendingId,
        note: "Awaiting user confirmation in the chat. Do NOT retry. Tell the user to tap Apply on the card above.",
      };
    },
  }),

  defineTool({
    name: "delete_invoice",
    description:
      "Propose deletion of an invoice. THIS DOES NOT DELETE — sends a confirmation card. REFUSED on locked invoices.",
    parameters: z.object({
      id: z.string().describe("Invoice id (cuid) or number like 'FACT-2026-00003'"),
    }),
    handler: async ({ id }, ctx) => {
      let realId = id;
      if (/^FACT-/.test(id)) {
        const inv = await prisma.invoice.findUnique({ where: { number: id } });
        if (!inv) throw new Error(`Invoice ${id} not found`);
        realId = inv.id;
      }
      const { summary, locked, lockReason } = await describeDeleteInvoice(realId);
      if (locked) {
        return {
          pending: false,
          error: "invoice_locked",
          message: `Cannot delete — ${lockReason ?? "invoice is locked"}.`,
        };
      }
      const pendingId = createPending({
        type: "delete_invoice",
        chatId: ctx.chatId,
        args: { id: realId },
        summary,
      });
      await tg.sendMessage(ctx.telegramToken, ctx.chatId, summary, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🗑️ Delete", callback_data: `pending:apply:${pendingId}` },
              { text: "✕ Cancel", callback_data: `pending:cancel:${pendingId}` },
            ],
          ],
        },
      });
      return {
        pending: true,
        pendingId,
        note: "Awaiting user confirmation. The invoice will NOT be deleted unless the user taps Delete.",
      };
    },
  }),

  defineTool({
    name: "recompute_deductions",
    description:
      "Re-apply category-based deduction rules to all confirmed expenses. Use after changing home-office %, RETA cuota, or other settings that affect deductions.",
    parameters: z.object({}),
    handler: async () => recomputeAllExpenseDeductions(),
  }),

  defineTool({
    name: "create_client",
    description:
      "Create a new billing client. countryCode drives the tax treatment: ES gives a Spanish client (IVA repercutido + IRPF retención, factura in Spanish), another EU country gives the intra-EU reverse charge (exempt, MOD 349), anywhere else is outside the scope of Spanish VAT. Rates default to the Settings values (21% IVA / 15% IRPF) — only pass vatRatePct/irpfRatePct to override, e.g. 7% IRPF during the first 3 years of activity. Returns the client id; pass it to create_invoice as clientId. Editing or deleting a client is web-UI-only (/clients).",
    parameters: z.object({
      name: z.string(),
      countryCode: z.string().describe("ISO 2-letter country code, e.g. ES, EE, DE"),
      addressLine: z.string(),
      postalCode: z.string(),
      city: z.string(),
      province: z.string().optional().describe("Province — expected on Spanish addresses."),
      country: z.string().optional().describe("Human-readable country name; derived from countryCode when omitted."),
      taxId: z.string().optional().describe("NIF/CIF for Spanish clients, local registration number otherwise. Required on a Spanish factura."),
      vatId: z.string().optional().describe("VAT ID with country prefix, e.g. EE102500628. Needed for MOD 349."),
      email: z.string().optional(),
      notes: z.string().optional(),
      vatTreatment: z
        .enum(["DOMESTIC_ES", "INTRA_EU_REVERSE_CHARGE", "EXPORT_NON_EU"])
        .optional()
        .describe("Override the treatment implied by countryCode."),
      vatRatePct: z.number().min(0).max(100).optional(),
      irpfRatePct: z.number().min(0).max(100).optional(),
      makeDefault: z.boolean().optional().describe("Use this client for invoices created without an explicit clientId."),
    }),
    handler: async (args) => {
      const settings = await prisma.settings.findUnique({ where: { id: 1 } });
      if (!settings) throw new Error("Settings missing — run db:seed");

      const countryCode = args.countryCode.trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(countryCode)) {
        throw new Error(`countryCode must be 2 letters, got "${args.countryCode}"`);
      }
      // Refuse near-duplicates rather than quietly creating a second row — the
      // agent should reuse the existing id.
      const existing = await prisma.client.findMany({ select: { id: true, name: true } });
      const clash = existing.find(
        (c) => c.name.trim().toLowerCase() === args.name.trim().toLowerCase()
      );
      if (clash) {
        return {
          error: "client_exists",
          message: `A client named "${clash.name}" already exists (id ${clash.id}). Use that id, or ask the user to rename.`,
          clientId: clash.id,
        };
      }

      const preset = taxPresetForCountry(countryCode, {
        vatRate: rateToPct(settings.defaultVatRate),
        irpfRate: rateToPct(settings.defaultIrpfRetentionRate),
      });
      const vatTreatment = args.vatTreatment ?? preset.vatTreatment;
      const domestic = vatTreatment === "DOMESTIC_ES";

      const created = await prisma.client.create({
        data: {
          name: args.name.trim(),
          taxId: args.taxId ?? null,
          vatId: args.vatId ?? null,
          countryCode,
          country: args.country ?? countryName(countryCode),
          addressLine: args.addressLine,
          postalCode: args.postalCode,
          city: args.city,
          province: args.province ?? null,
          email: args.email ?? null,
          notes: args.notes ?? null,
          vatTreatment,
          // Exempt treatments never carry rates.
          defaultVatRate: domestic ? pctToRate(args.vatRatePct ?? preset.vatRate) : 0,
          irpfRetentionRate: domestic ? pctToRate(args.irpfRatePct ?? preset.irpfRate) : 0,
          invoiceLocale: args.vatTreatment ? (domestic ? "es" : "en") : preset.locale,
        },
      });

      if (args.makeDefault || !settings.defaultClientId) {
        await prisma.settings.update({
          where: { id: 1 },
          data: { defaultClientId: created.id },
        });
      }

      const warnings: string[] = [];
      if (domestic && !created.taxId) {
        warnings.push(
          "No NIF/CIF on file — a Spanish factura legally needs the client's NIF. Ask the user for it and add it at /clients."
        );
      }
      if (vatTreatment === "INTRA_EU_REVERSE_CHARGE" && !created.vatId) {
        warnings.push("No VAT ID on file — required to report this client in MOD 349.");
      }

      return {
        id: created.id,
        name: created.name,
        countryCode: created.countryCode,
        vatTreatment: created.vatTreatment,
        vatRatePct: rateToPct(created.defaultVatRate),
        irpfRatePct: rateToPct(created.irpfRetentionRate),
        invoiceLocale: created.invoiceLocale,
        isDefault: args.makeDefault || !settings.defaultClientId,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    },
  }),

  defineTool({
    name: "list_clients",
    description:
      "List billing clients on file, with each one's VAT treatment and IVA/IRPF rates. Clients are created and edited in the web UI at /clients, not from chat.",
    parameters: z.object({}),
    handler: async () => {
      const cs = await prisma.client.findMany({ orderBy: { name: "asc" } });
      return cs.map((c) => ({
        id: c.id,
        name: c.name,
        vatId: c.vatId,
        taxId: c.taxId,
        country: c.country,
        countryCode: c.countryCode,
        vatTreatment: c.vatTreatment,
        vatRatePct: rateToPct(c.defaultVatRate),
        irpfRatePct: rateToPct(c.irpfRetentionRate),
      }));
    },
  }),
];

// ---- helpers ----

type ToolHandler<P extends z.ZodTypeAny> = (
  args: z.output<P>,
  ctx: ToolContext
) => Promise<unknown>;

type ToolDef<P extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  description: string;
  parameters: P;
  handler: ToolHandler<P>;
};

function defineTool<P extends z.ZodTypeAny>(t: ToolDef<P>): ToolDef<P> {
  return t;
}

function parseDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`Invalid date: ${s}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
}

function addDays(d: Date, days: number): Date {
  const c = new Date(d.getTime());
  c.setUTCDate(c.getUTCDate() + days);
  return c;
}

// Convert zod schema to JSON Schema for OpenAI function tools. Recharts/zod-to-json-schema
// would be the canonical solution but for our small schemas we can build the
// JSON inline; we use zod's `.shape` introspection.
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, val] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(val);
      if (!val.isOptional()) required.push(key);
    }
    return {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    };
  }
  if (schema instanceof z.ZodString) return { type: "string", description: schema.description };
  if (schema instanceof z.ZodNumber) {
    const s: Record<string, unknown> = { type: "number", description: schema.description };
    return s;
  }
  if (schema instanceof z.ZodBoolean) return { type: "boolean", description: schema.description };
  if (schema instanceof z.ZodEnum) {
    return { type: "string", enum: schema.options, description: schema.description };
  }
  if (schema instanceof z.ZodLiteral) {
    return { type: typeof schema.value === "number" ? "number" : "string", enum: [schema.value] };
  }
  if (schema instanceof z.ZodUnion) {
    const opts = (schema.options as unknown as z.ZodTypeAny[]) ?? [];
    return { anyOf: opts.map((o) => zodToJsonSchema(o)) };
  }
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap() as z.ZodTypeAny);
  if (schema instanceof z.ZodDefault) return zodToJsonSchema(schema.removeDefault() as z.ZodTypeAny);
  // Fallback
  return { type: "string", description: schema.description };
}

// ---- public API ----

export function listToolsForOpenAI(): Array<{
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: false;
}> {
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: zodToJsonSchema(t.parameters),
    // strict mode requires `additionalProperties: false` and disallows optional
    // properties unless explicitly nullable — our schemas use optional+union freely,
    // so disable strict and trust the zod runtime validation in executeTool().
    strict: false as const,
  }));
}

export async function executeTool(
  name: string,
  args: unknown,
  ctx: ToolContext
): Promise<unknown> {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Unknown tool: ${name}`);
  const parsed = t.parameters.safeParse(args ?? {});
  if (!parsed.success) {
    return { error: "Invalid arguments", issues: parsed.error.issues };
  }
  try {
    const result = await t.handler(parsed.data, ctx);
    return result ?? { ok: true };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const TOOL_NAMES = tools.map((t) => t.name);
