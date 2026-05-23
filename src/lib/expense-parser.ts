import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

// Limit to the categories the user actually encounters. The model picks one
// and we then apply the category's default deduction rule (set in lib/deduction.ts).
export const EXPENSE_CATEGORIES = [
  "UTILITY_ELECTRICITY",
  "UTILITY_INTERNET",
  "UTILITY_WATER",
  "UTILITY_GAS",
  "RENT_HOUSING",
  "SOCIAL_SECURITY",
  "GESTORIA",
  "SOFTWARE",
  "BANK_FEES",
  "OTHER_DEDUCTIBLE",
  "NON_DEDUCTIBLE",
] as const;

const ExpenseExtractionSchema = z.object({
  date: z
    .string()
    .describe(
      "Invoice/issuance date in YYYY-MM-DD. Use the document's issuance date, not payment due date."
    ),
  vendor: z.string().describe("Vendor / supplier name as it appears on the document."),
  vendorVatId: z
    .string()
    .nullable()
    .describe("Vendor VAT / tax ID with country prefix if present (e.g. ESA12345678), or null."),
  totalGrossCents: z
    .number()
    .int()
    .describe("Total amount the customer paid, in cents (EUR). Includes VAT."),
  netBaseCents: z
    .number()
    .int()
    .describe("Net / taxable base in cents, before VAT. If no VAT, equals totalGrossCents."),
  vatCents: z
    .number()
    .int()
    .describe("VAT amount in cents. 0 if the document has no VAT or it's exempt."),
  vatRate: z
    .number()
    .describe("VAT rate as a fraction (e.g. 0.21 for 21%, 0 if exempt or non-VAT)."),
  currency: z.string().describe('ISO currency code, usually "EUR". Default to "EUR" if unclear.'),
  suggestedCategory: z
    .enum(EXPENSE_CATEGORIES)
    .describe(
      [
        "Best-guess expense category.",
        "UTILITY_ELECTRICITY — Holaluz, Iberdrola, Endesa, Naturgy electricity, Repsol Electricidad.",
        "UTILITY_INTERNET — Vodafone, Movistar, Orange, DIGI, Yoigo, MásMóvil, Lowi internet/phone bills.",
        "UTILITY_WATER — Aigües de Barcelona, Canal de Isabel II, EMASESA, Aguas de Valencia.",
        "UTILITY_GAS — Eni Plenitude, Naturgy gas, Repsol gas, Endesa gas.",
        "RENT_HOUSING — monthly rent payments. Bank-transfer screenshots labelled 'RENTA', 'ALQUILER', 'rent', or recurring transfers of a fixed amount to a private individual with a street-name reference in the concept field (BBVA, Wise, Revolut, SEPA).",
        "SOCIAL_SECURITY — TGSS / Tesorería General de la Seguridad Social / RETA / SEGSOC charge receipts (typically end of month).",
        "GESTORIA — Xolo, Quipu, Declarando, Anfix, Sage One, Holded, any other accountant/gestoría invoices.",
        "SOFTWARE — AWS, GitHub, GitLab, Figma, Notion, Anthropic, OpenAI, Vercel, Cloudflare, JetBrains, Adobe, Linear, 1Password — any SaaS / dev tool / domain registrar / VPS billed monthly or yearly.",
        "BANK_FEES — bank account maintenance, wire-transfer fees from BBVA, Caixabank, Wise, Revolut, N26.",
        "OTHER_DEDUCTIBLE — anything else genuinely business-related, fully deductible. THIS IS WHERE MUNICIPAL BUSINESS TAXES GO. Specifically: Barcelona 'Institut Municipal d'Hisenda' OR 'Ajuntament de Barcelona' issuing a 'preu públic per recollida de residus comercials' / 'tasa de residuos comerciales' (charged BECAUSE of autónomo registration → 100% deductible, NOT a household cost). Also: IAE (Impuesto sobre Actividades Económicas), business-license fees, coworking invoices (Onecowork, WeWork, Talent Garden), business hardware purchases with invoice, professional insurance, books / training relevant to the activity, professional association fees.",
        "NON_DEDUCTIBLE — unidentifiable receipts, personal transfers, restaurant/grocery receipts without a clear business reason, sanctions/fines (NEVER deductible by law), traffic tickets, residential IBI on a property the user doesn't own, the household 'taxa metropolitana de tractament de residus' bundled in the water bill (≠ the commercial waste fee above).",
      ].join(" "),
    ),
  notes: z
    .string()
    .nullable()
    .describe("Any additional context (period covered, line description), 1 short sentence."),
});

export type ExpenseExtraction = z.infer<typeof ExpenseExtractionSchema>;

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
    _client = new OpenAI();
  }
  return _client;
}

export async function parseExpensePdf(args: {
  pdfBuffer: Buffer;
  filename: string;
}): Promise<ExpenseExtraction> {
  const base64 = args.pdfBuffer.toString("base64");
  const fileData = `data:application/pdf;base64,${base64}`;

  const response = await client().responses.parse({
    model: "gpt-5.4-mini",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "Extract expense fields from this Spanish invoice/receipt PDF. " +
              "All amounts are in cents (multiply euros by 100, round to nearest cent). " +
              "If the PDF has no VAT (typical for bank-transfer receipts), set vatCents=0, " +
              "vatRate=0, netBaseCents=totalGrossCents. " +
              "Choose suggestedCategory from the transfer concept/reference/vendor — never " +
              "from VAT presence. In particular, a recurring transfer to a private individual " +
              "with a rent reference in the concept (RENTA, ALQUILER, rent, or a street name) " +
              "is RENT_HOUSING, not NON_DEDUCTIBLE. Only use NON_DEDUCTIBLE when the document " +
              "genuinely has no identifiable business purpose.",
          },
          {
            type: "input_file",
            filename: args.filename,
            file_data: fileData,
          },
        ],
      },
    ],
    text: {
      format: zodTextFormat(ExpenseExtractionSchema, "expense"),
    },
  });

  if (!response.output_parsed) {
    throw new Error("Model did not return parsed output");
  }
  return response.output_parsed;
}
