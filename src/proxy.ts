import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const SESSION_COOKIE = "sg_session";

async function verifyToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) return false;
  try {
    await jwtVerify(token, new TextEncoder().encode(s), { algorithms: ["HS256"] });
    return true;
  } catch {
    return false;
  }
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // Public routes
  if (
    pathname === "/login" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon")
  ) {
    return NextResponse.next();
  }

  const ok = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!ok) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const params = new URLSearchParams({ next: pathname });
    return new NextResponse(null, {
      status: 307,
      headers: { Location: `/login?${params}` },
    });
  }
  return NextResponse.next();
}

export const config = {
  // Run on everything except static assets & favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.svg).*)"],
};
