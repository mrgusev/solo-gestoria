import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db";
import { bootstrapBankAccounts } from "../src/lib/bank-accounts-db";
import { normalizeIban } from "../src/lib/bank-accounts";

type SeedConfig = {
  settings: {
    issuerName: string;
    issuerTaxId: string;
    issuerVatId: string;
    issuerAddressLine: string;
    issuerPostalCode: string;
    issuerCity: string;
    issuerProvince: string;
    issuerCountry: string;
    issuerEmail: string | null;
    issuerPhone?: string | null;
    bankName: string;
    bankIban: string;
    bankSwift: string;
    bankAddress: string | null;
    defaultHourlyRateCents: number;
    defaultLineDescription: string;
    homeOfficePct: number;
    homeOfficeStartDate: string | null; // YYYY-MM-DD
    retaMonthlyCuotaCents: number;
    // Optional — an existing seed.config.json predating VAT/IRPF support just
    // falls back to the schema defaults (21% IVA, 15% retención).
    defaultVatRate?: number;
    defaultIrpfRetentionRate?: number;
  };
  // Payment destinations. Optional — an install with none keeps using the
  // single account bootstrapped from settings.bank* above. Each entry needs a
  // stable id so re-seeding updates nothing it shouldn't.
  bankAccounts?: {
    id: string;
    label: string;
    beneficiary?: string | null;
    bankName: string;
    iban: string;
    swift: string;
    address?: string | null;
    notes?: string | null;
    // Comma-separated VatTreatment values, e.g. "DOMESTIC_ES".
    defaultForTreatments?: string | null;
    isDefault?: boolean;
    useForAeat?: boolean;
  }[];
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
    province?: string | null;
    // Optional — defaults to the intra-EU reverse charge, which is what every
    // pre-existing config described.
    vatTreatment?: "DOMESTIC_ES" | "INTRA_EU_REVERSE_CHARGE" | "EXPORT_NON_EU";
    defaultVatRate?: number;
    irpfRetentionRate?: number;
    invoiceLocale?: string;
  };
  agent?: {
    userDescription?: string;
    businessNotes?: string;
  };
};

async function loadConfig(): Promise<SeedConfig> {
  const realPath = path.join(__dirname, "seed.config.json");
  const examplePath = path.join(__dirname, "seed.config.example.json");
  try {
    const raw = await fs.readFile(realPath, "utf8");
    return JSON.parse(raw) as SeedConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    console.warn(
      "⚠️  prisma/seed.config.json not found — seeding with placeholder values from seed.config.example.json.\n" +
        "    Copy seed.config.example.json → seed.config.json and edit before running in production."
    );
    const raw = await fs.readFile(examplePath, "utf8");
    return JSON.parse(raw) as SeedConfig;
  }
}

async function main() {
  const cfg = await loadConfig();
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

  // Turn a pre-multi-account install's Settings.bank* into the first
  // BankAccount (and point its existing invoices at it) before adding any
  // configured ones — otherwise the bootstrap would see a non-empty table and
  // skip, leaving those invoices without an account.
  await bootstrapBankAccounts();

  for (const account of cfg.bankAccounts ?? []) {
    await prisma.bankAccount.upsert({
      where: { id: account.id },
      update: {},
      create: {
        id: account.id,
        label: account.label,
        beneficiary: account.beneficiary ?? null,
        bankName: account.bankName,
        iban: normalizeIban(account.iban),
        swift: account.swift.toUpperCase(),
        address: account.address ?? null,
        notes: account.notes ?? null,
        defaultForTreatments: account.defaultForTreatments ?? null,
        isDefault: account.isDefault ?? false,
        useForAeat: account.useForAeat ?? false,
      },
    });
  }

  await prisma.client.upsert({
    where: { id: cfg.defaultClient.id },
    update: {},
    create: cfg.defaultClient,
  });

  const accountCount = await prisma.bankAccount.count();
  console.log(
    `Seed complete. Issuer: ${cfg.settings.issuerName} · Default client: ${cfg.defaultClient.name}` +
      ` · Bank accounts: ${accountCount}`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
