import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { promises as fs } from "node:fs";
import { prisma } from "@/lib/db";
import { parseExpensePdf } from "@/lib/expense-parser";
import { applyDeduction, defaultDeductiblePct } from "@/lib/deduction";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "./uploads";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json({ error: "Only PDF accepted" }, { status: 415 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  let parsed;
  try {
    parsed = await parseExpensePdf({ pdfBuffer: buffer, filename: file.name });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Parse failed" },
      { status: 500 }
    );
  }

  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) {
    return NextResponse.json({ error: "Settings missing" }, { status: 500 });
  }

  const date = safeDate(parsed.date) ?? new Date();
  const deductiblePct = defaultDeductiblePct(parsed.suggestedCategory, settings, date);
  const ded = applyDeduction(deductiblePct, parsed.netBaseCents, parsed.vatCents);

  // Persist the PDF under uploads/expenses/<uuid>.pdf so we can keep a copy.
  await fs.mkdir(path.join(UPLOAD_DIR, "expenses"), { recursive: true });
  const id = crypto.randomUUID();
  const relPath = path.join("expenses", `${id}.pdf`);
  const absPath = path.join(UPLOAD_DIR, relPath);
  await fs.writeFile(absPath, buffer);

  const created = await prisma.expense.create({
    data: {
      date,
      vendor: parsed.vendor,
      vendorVatId: parsed.vendorVatId ?? null,
      category: parsed.suggestedCategory,
      grossCents: parsed.totalGrossCents,
      netCents: parsed.netBaseCents,
      vatRate: parsed.vatRate,
      vatCents: parsed.vatCents,
      deductiblePct,
      deductibleNetCents: ded.deductibleNetCents,
      deductibleVatCents: ded.deductibleVatCents,
      pdfPath: relPath,
      parsedJson: JSON.stringify(parsed),
      status: "PENDING_REVIEW",
      source: "UPLOAD",
      currency: parsed.currency || "EUR",
      notes: parsed.notes,
    },
  });

  return NextResponse.json({ id: created.id });
}

function safeDate(s: string): Date | null {
  // Accept YYYY-MM-DD or YYYY/MM/DD.
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(Date.UTC(y, mo - 1, d, 12));
}
