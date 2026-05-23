import { NextRequest } from "next/server";
import path from "node:path";
import { promises as fs } from "node:fs";
import { prisma } from "@/lib/db";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "./uploads";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const expense = await prisma.expense.findUnique({ where: { id } });
  if (!expense || !expense.pdfPath) {
    return new Response("Not found", { status: 404 });
  }
  // Defense-in-depth against path traversal — only allow paths under UPLOAD_DIR.
  const abs = path.resolve(UPLOAD_DIR, expense.pdfPath);
  const root = path.resolve(UPLOAD_DIR);
  if (!abs.startsWith(root + path.sep)) {
    return new Response("Forbidden", { status: 403 });
  }
  try {
    const buf = await fs.readFile(abs);
    // Sanitize vendor (LLM-parsed from arbitrary PDF content) before putting
    // it into a response header — strips quotes, CRLF, non-ASCII.
    const safeVendor = expense.vendor.replace(/[^\w.-]/g, "_").slice(0, 60);
    const safeDate = expense.date.toISOString().slice(0, 10);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${safeVendor}-${safeDate}.pdf"`,
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
