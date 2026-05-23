import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db";

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
    bankName: string;
    bankIban: string;
    bankSwift: string;
    bankAddress: string | null;
    defaultHourlyRateCents: number;
    defaultLineDescription: string;
    homeOfficePct: number;
    homeOfficeStartDate: string | null; // YYYY-MM-DD
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

  await prisma.client.upsert({
    where: { id: cfg.defaultClient.id },
    update: {},
    create: cfg.defaultClient,
  });

  console.log(`Seed complete. Issuer: ${cfg.settings.issuerName} · Default client: ${cfg.defaultClient.name}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
