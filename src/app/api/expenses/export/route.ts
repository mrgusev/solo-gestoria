import path from "node:path";
import { promises as fs } from "node:fs";
import { prisma } from "@/lib/db";
import { buildZip, type ZipEntry } from "@/lib/zip";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "./uploads";

// Download every expense PDF as a single ZIP, grouped by quarter:
//   2026-Q1/2026-01-15_Vendor.pdf
export async function GET() {
  const expenses = await prisma.expense.findMany({
    where: { pdfPath: { not: null } },
    orderBy: { date: "asc" },
  });

  const root = path.resolve(UPLOAD_DIR);
  const used = new Set<string>();
  const entries: ZipEntry[] = [];

  for (const e of expenses) {
    // Same path-traversal guard as /api/expenses/[id]/pdf.
    const abs = path.resolve(UPLOAD_DIR, e.pdfPath!);
    if (!abs.startsWith(root + path.sep)) continue;
    let data: Buffer;
    try {
      data = await fs.readFile(abs);
    } catch {
      continue; // file missing on disk — skip rather than fail the whole export
    }

    const day = e.date.toISOString().slice(0, 10);
    const folder = `${day.slice(0, 4)}-Q${Math.floor(e.date.getUTCMonth() / 3) + 1}`;
    // Vendor is LLM-parsed from arbitrary PDFs: strip path separators and
    // characters that are invalid in Windows filenames.
    const vendor =
      e.vendor.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 60) ||
      "expense";
    const ext = path.extname(e.pdfPath!) || ".pdf";
    let name = `${folder}/${day}_${vendor}${ext}`;
    for (let i = 2; used.has(name.toLowerCase()); i++) {
      name = `${folder}/${day}_${vendor} (${i})${ext}`;
    }
    used.add(name.toLowerCase());
    entries.push({ name, data, date: e.date });
  }

  const zip = buildZip(entries);
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(zip, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="expenses-${stamp}.zip"`,
      "Content-Length": String(zip.length),
    },
  });
}
