/**
 * Migrate historical bookkeeping data from a folder of exported PDFs.
 *
 *   npx tsx scripts/migrate-historical.ts [--source ./dataexport] [--dry-run]
 *
 * Inputs (no per-record manifests needed):
 *   1. prisma/seed.config.json   — your Settings + default Client
 *   2. <source>/INVOICE/*.pdf    — historical invoice PDFs (any layout)
 *   3. <source>/EXPENSE/*.pdf    — historical expense / receipt PDFs (any layout)
 *
 * What it does:
 *   - Runs the seed (Settings + Client upsert from seed.config.json) if needed.
 *   - For each invoice PDF: sends it through OpenAI structured extraction
 *     (src/lib/invoice-parser.ts), creates an Invoice + InvoiceLine row,
 *     copies the PDF to uploads/invoices/<id>.pdf, sets pdfPath.
 *     Idempotent — skips invoices whose extracted number already exists.
 *   - For each expense PDF: sends it through the existing OpenAI parser
 *     (src/lib/expense-parser.ts), creates a CONFIRMED Expense row, copies
 *     the PDF to uploads/expenses/<uuid>.pdf, sets pdfPath.
 *     NOT idempotent for expenses — wipe DB before re-running for clean tests.
 *   - Auto-creates any missing AUTO_RETA expenses via ensureRetaExpensesForYear.
 *
 * Costs: ~$0.001 per PDF (gpt-5.4-mini structured extraction). 100 PDFs ≈ $0.10.
 */
import "dotenv/config";
import path from "node:path";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { prisma } from "../src/lib/db";
import { parseInvoicePdf } from "../src/lib/invoice-parser";
import { parseExpensePdf } from "../src/lib/expense-parser";
import { applyDeduction, defaultDeductiblePct } from "../src/lib/deduction";
import { ensureRetaExpensesForYear } from "../src/lib/reta";
import { invoicePdfRelPath } from "../src/lib/invoice";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "./uploads";

type SeedConfig = {
  settings: Record<string, unknown> & {
    issuerName: string;
    issuerTaxId: string;
    issuerVatId: string;
    issuerAddressLine: string;
    issuerPostalCode: string;
    issuerCity: string;
    issuerProvince: string;
    issuerCountry: string;
    issuerEmail: string | null;
    bankName: string;
    bankIban: string;
    bankSwift: string;
    bankAddress: string | null;
    defaultHourlyRateCents: number;
    defaultLineDescription: string;
    homeOfficePct: number;
    homeOfficeStartDate: string | null;
    retaMonthlyCuotaCents: number;
  };
  defaultClient: {
    id: string;
    name: string;
    taxId: string | null;
    vatId: string | null;
    countryCode: string;
    addressLine: string;
    postalCode: string;
    city: string;
    country: string;
    email: string | null;
  };
};

function parseArgs(): { source: string; dryRun: boolean } {
  const args = process.argv.slice(2);
  let source = "./dataexport";
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source") {
      source = args[++i];
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    }
  }
  return { source: path.resolve(source), dryRun };
}

async function loadSeedConfig(): Promise<SeedConfig> {
  const p = path.join(process.cwd(), "prisma/seed.config.json");
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as SeedConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "prisma/seed.config.json not found. Copy seed.config.example.json → seed.config.json and fill in your details first."
      );
    }
    throw err;
  }
}

async function ensureSettingsAndClient(cfg: SeedConfig, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(`[dry-run] would upsert Settings (${cfg.settings.issuerName}) + Client (${cfg.defaultClient.name})`);
    return;
  }
  const now = new Date();
  await prisma.settings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      ...cfg.settings,
      homeOfficeStartDate: cfg.settings.homeOfficeStartDate
        ? new Date(cfg.settings.homeOfficeStartDate + "T12:00:00.000Z")
        : null,
      invoiceNumberYear: now.getFullYear(),
      invoiceNumberSeq: 1,
      defaultClientId: cfg.defaultClient.id,
    },
  });
  await prisma.client.upsert({
    where: { id: cfg.defaultClient.id },
    update: {},
    create: cfg.defaultClient,
  });
}

function parseIsoDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
}

async function migrateInvoices(opts: {
  sourceDir: string;
  defaultClientId: string;
  dryRun: boolean;
}): Promise<{ created: number; skipped: number; failed: number }> {
  const dir = path.join(opts.sourceDir, "INVOICE");
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".pdf"));
  } catch {
    console.log(`[invoices] no ${dir} directory — skipping`);
    return { created: 0, skipped: 0, failed: 0 };
  }
  console.log(`\n[invoices] ${files.length} PDFs in ${dir}`);
  let created = 0, skipped = 0, failed = 0;
  if (!opts.dryRun) {
    await fs.mkdir(path.join(UPLOAD_DIR, "invoices"), { recursive: true });
  }
  for (const file of files.sort()) {
    const abs = path.join(dir, file);
    try {
      const buf = await fs.readFile(abs);
      const parsed = await parseInvoicePdf({ pdfBuffer: buf, filename: file });
      // Prefer a FACT-YYYY-NNNNN in the filename, fall back to extracted number.
      const factMatch = /FACT-\d{4}-\d{5}/.exec(file);
      const number = factMatch?.[0] ?? parsed.number ?? null;
      if (!number) {
        console.warn(`  ✗ ${file}: no invoice number found — skipped`);
        failed++;
        continue;
      }
      const issueDate = parseIsoDate(parsed.date);
      if (!issueDate) {
        console.warn(`  ✗ ${file}: invalid date ${parsed.date} — skipped`);
        failed++;
        continue;
      }
      const dueDate = parsed.dueDate ? parseIsoDate(parsed.dueDate) : null;

      const existing = await prisma.invoice.findUnique({ where: { number } });
      if (existing) {
        console.log(`  · ${number}: already exists — skipped`);
        skipped++;
        continue;
      }
      if (opts.dryRun) {
        console.log(`  [dry] ${number}  ${parsed.date}  ${parsed.hours}${parsed.unit} × €${(parsed.hourlyRateCents / 100).toFixed(2)} = €${(parsed.totalCents / 100).toFixed(2)}`);
        created++;
        continue;
      }
      const inv = await prisma.invoice.create({
        data: {
          number,
          date: issueDate,
          dueDate: dueDate ?? new Date(issueDate.getTime() + 30 * 86400_000),
          clientId: opts.defaultClientId,
          subtotalCents: parsed.netCents,
          vatCents: parsed.vatCents,
          totalCents: parsed.totalCents,
          currency: parsed.currency || "EUR",
          vatExempt: parsed.vatExempt,
          lines: {
            create: [
              {
                position: 1,
                description: parsed.description,
                quantity: parsed.hours,
                unit: parsed.unit || "h",
                unitPriceCents: parsed.hourlyRateCents,
                vatRate: parsed.vatExempt ? 0 : parsed.netCents > 0 ? parsed.vatCents / parsed.netCents : 0,
                netCents: parsed.netCents,
              },
            ],
          },
        },
        select: { id: true, number: true },
      });
      // Copy the original PDF (preserve exact bytes; don't re-render).
      const relPath = invoicePdfRelPath(inv.id);
      await fs.copyFile(abs, path.join(UPLOAD_DIR, relPath));
      await prisma.invoice.update({ where: { id: inv.id }, data: { pdfPath: relPath } });
      console.log(`  ✓ ${number}  →  ${relPath}`);
      created++;
    } catch (err) {
      console.error(`  ✗ ${file}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
  return { created, skipped, failed };
}

async function migrateExpenses(opts: {
  sourceDir: string;
  dryRun: boolean;
}): Promise<{ created: number; failed: number }> {
  const dir = path.join(opts.sourceDir, "EXPENSE");
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".pdf"));
  } catch {
    console.log(`[expenses] no ${dir} directory — skipping`);
    return { created: 0, failed: 0 };
  }
  console.log(`\n[expenses] ${files.length} PDFs in ${dir}`);
  const settings = opts.dryRun ? null : await prisma.settings.findUnique({ where: { id: 1 } });
  if (!opts.dryRun && !settings) throw new Error("Settings missing — seed first");
  let created = 0, failed = 0;
  if (!opts.dryRun) {
    await fs.mkdir(path.join(UPLOAD_DIR, "expenses"), { recursive: true });
  }
  for (const file of files.sort()) {
    const abs = path.join(dir, file);
    try {
      const buf = await fs.readFile(abs);
      const parsed = await parseExpensePdf({ pdfBuffer: buf, filename: file });
      const date = parseIsoDate(parsed.date) ?? new Date();
      if (opts.dryRun) {
        console.log(`  [dry] ${parsed.date}  ${parsed.vendor.slice(0, 40).padEnd(40)}  €${(parsed.totalGrossCents / 100).toFixed(2)}  [${parsed.suggestedCategory}]`);
        created++;
        continue;
      }
      const pct = defaultDeductiblePct(parsed.suggestedCategory, settings!, date);
      const ded = applyDeduction(pct, parsed.netBaseCents, parsed.vatCents);
      const expenseId = crypto.randomUUID();
      const relPath = path.join("expenses", `${expenseId}.pdf`);
      await fs.copyFile(abs, path.join(UPLOAD_DIR, relPath));
      await prisma.expense.create({
        data: {
          date,
          vendor: parsed.vendor,
          vendorVatId: parsed.vendorVatId ?? null,
          category: parsed.suggestedCategory,
          grossCents: parsed.totalGrossCents,
          netCents: parsed.netBaseCents,
          vatRate: parsed.vatRate,
          vatCents: parsed.vatCents,
          deductiblePct: pct,
          deductibleNetCents: ded.deductibleNetCents,
          deductibleVatCents: ded.deductibleVatCents,
          pdfPath: relPath,
          parsedJson: JSON.stringify(parsed),
          status: "CONFIRMED",
          source: "UPLOAD",
          currency: parsed.currency || "EUR",
          notes: parsed.notes,
        },
      });
      console.log(`  ✓ ${parsed.date}  ${parsed.vendor.slice(0, 38).padEnd(38)}  €${(parsed.totalGrossCents / 100).toFixed(2).padStart(9)}`);
      created++;
    } catch (err) {
      console.error(`  ✗ ${file}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
  return { created, failed };
}

async function main() {
  const { source, dryRun } = parseArgs();
  console.log(`Migrating from: ${source}${dryRun ? "  (DRY RUN — no DB changes)" : ""}`);

  const cfg = await loadSeedConfig();
  await ensureSettingsAndClient(cfg, dryRun);

  const inv = await migrateInvoices({
    sourceDir: source,
    defaultClientId: cfg.defaultClient.id,
    dryRun,
  });
  const exp = await migrateExpenses({ sourceDir: source, dryRun });

  if (!dryRun) {
    // Auto-create the AUTO_RETA monthly cuota expenses for every year that
    // has at least one invoice — keeps RETA history aligned with revenue.
    const years = await prisma.invoice.findMany({
      distinct: ["date"],
      select: { date: true },
    });
    const yearSet = new Set(years.map((y) => y.date.getUTCFullYear()));
    for (const y of yearSet) await ensureRetaExpensesForYear(y);
  }

  console.log("\n=== Summary ===");
  console.log(`Invoices: ${inv.created} created, ${inv.skipped} skipped, ${inv.failed} failed`);
  console.log(`Expenses: ${exp.created} created, ${exp.failed} failed`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
