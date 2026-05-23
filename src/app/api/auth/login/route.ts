import { NextRequest, NextResponse } from "next/server";
import { checkPassword, issueSession } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const password = String(form.get("password") ?? "");
  if (!checkPassword(password)) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("error", "1");
    const next = String(form.get("next") ?? "/");
    if (next && next !== "/") url.searchParams.set("next", next);
    return NextResponse.redirect(url, { status: 303 });
  }
  await issueSession();
  const next = String(form.get("next") ?? "/");
  const dest = req.nextUrl.clone();
  dest.pathname = next.startsWith("/") ? next : "/";
  dest.search = "";
  return NextResponse.redirect(dest, { status: 303 });
}
