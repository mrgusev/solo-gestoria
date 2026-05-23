import { NextRequest } from "next/server";
import path from "node:path";
import { promises as fs } from "node:fs";
import { prisma } from "@/lib/db";
import { renderInvoicePdf } from "@/lib/invoice-pdf";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "./uploads";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const [invoice, settings] = await Promise.all([
    prisma.invoice.findUnique({
      where: { id },
      include: { lines: true, client: true },
    }),
    prisma.settings.findUnique({ where: { id: 1 } }),
  ]);
  if (!invoice || !settings) {
    return new Response("Not found", { status: 404 });
  }

  // Sanitize the vendor-controlled invoice number out of the filename header
  // to prevent header injection. FACT-YYYY-NNNNN is well-formed but defense
  // in depth keeps quotes / CRLF / non-ASCII out of the response.
  const safeName = invoice.number.replace(/[^\w.-]/g, "_").slice(0, 80);
  const headers = {
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${safeName}.pdf"`,
  } as const;

  // Prefer the on-disk persisted PDF (written on create/update). Fall back
  // to on-the-fly render if it's missing — keeps legacy rows usable until
  // backfill is run.
  if (invoice.pdfPath) {
    const abs = path.resolve(UPLOAD_DIR, invoice.pdfPath);
    const root = path.resolve(UPLOAD_DIR);
    if (abs.startsWith(root + path.sep)) {
      try {
        const buf = await fs.readFile(abs);
        return new Response(new Uint8Array(buf), { headers });
      } catch {
        /* fall through to live render */
      }
    }
  }

  const pdf = await renderInvoicePdf({ invoice, settings });
  return new Response(new Uint8Array(pdf), { headers });
}
