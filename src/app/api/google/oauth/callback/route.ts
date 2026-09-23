// Google redirects here after the consent screen. Behind the session cookie
// like every other non-/api/auth route (see src/proxy.ts) — the consent flow
// is a top-level navigation, so the Lax cookie rides along.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { exchangeCodeForRefreshToken, defaultRedirectUri } from "@/lib/google-oauth";

function settingsUrl(req: NextRequest, params: Record<string, string>): URL {
  // Build from the forwarded headers: nextUrl reports the container's bind
  // address under the standalone server, which a browser can't follow.
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3010";
  const url = new URL("/settings", `${proto}://${host}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");
  if (error) {
    return NextResponse.redirect(settingsUrl(req, { google: "error", msg: error }));
  }
  if (!code) {
    return NextResponse.redirect(
      settingsUrl(req, { google: "error", msg: "Google returned no authorization code" })
    );
  }

  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings?.googleClientId || !settings.googleClientSecret) {
    return NextResponse.redirect(
      settingsUrl(req, { google: "error", msg: "Save the client ID and secret first" })
    );
  }

  try {
    const { refreshToken } = await exchangeCodeForRefreshToken({
      clientId: settings.googleClientId,
      clientSecret: settings.googleClientSecret,
      code,
      // Must byte-match the redirect_uri sent to the consent screen, or Google
      // rejects the exchange with redirect_uri_mismatch.
      redirectUri: settings.googleRedirectUri ?? defaultRedirectUri(req.nextUrl.origin),
    });
    await prisma.settings.update({
      where: { id: 1 },
      data: { googleRefreshToken: refreshToken, smtpAuthType: "OAUTH2" },
    });
    return NextResponse.redirect(settingsUrl(req, { google: "ok" }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.redirect(settingsUrl(req, { google: "error", msg: message }));
  }
}
