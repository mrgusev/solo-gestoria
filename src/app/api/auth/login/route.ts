import { NextRequest, NextResponse } from "next/server";
import { checkPassword, issueSession } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const password = String(form.get("password") ?? "");
  if (!checkPassword(password)) {
    const params = new URLSearchParams({ error: "1" });
    const next = String(form.get("next") ?? "/");
    if (next && next !== "/") params.set("next", next);
    return new NextResponse(null, {
      status: 303,
      headers: { Location: `/login?${params}` },
    });
  }
  await issueSession();
  const next = String(form.get("next") ?? "/");
  const dest = next.startsWith("/") ? next : "/";
  return new NextResponse(null, { status: 303, headers: { Location: dest } });
}
