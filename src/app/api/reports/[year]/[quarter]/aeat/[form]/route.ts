import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { computeQuarterReport, type Quarter } from "@/lib/tax";
import { buildMod130, buildMod303, buildMod349 } from "@/lib/aeat";

type Params = Promise<{ year: string; quarter: string; form: string }>;

export async function GET(_req: NextRequest, { params }: { params: Params }) {
  const { year: yearStr, quarter: qStr, form } = await params;
  const year = Number(yearStr);
  const q = Number(qStr) as Quarter;
  if (!Number.isFinite(year) || ![1, 2, 3, 4].includes(q)) {
    return new Response("Bad params", { status: 400 });
  }
  if (!["130", "303", "349"].includes(form)) {
    return new Response("Unknown form", { status: 404 });
  }

  const [settings, report] = await Promise.all([
    prisma.settings.findUnique({ where: { id: 1 } }),
    computeQuarterReport(year, q),
  ]);
  if (!settings) return new Response("Settings missing", { status: 500 });

  let body: Buffer;
  let filename: string;
  if (form === "130") {
    body = buildMod130({ settings, report });
    filename = `mod130-${year}-${q}T.130`;
  } else if (form === "303") {
    body = buildMod303({ settings, report });
    filename = `mod303-${year}-${q}T.303`;
  } else {
    body = buildMod349({ settings, report });
    filename = `mod349-${year}-${q}T.349`;
  }

  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "text/plain; charset=ISO-8859-1",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
