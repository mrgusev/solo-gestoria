import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { prisma } from "@/lib/db";
import { paletteCss, resolvePalette } from "@/lib/palettes";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Solo Gestoría",
  description: "Spanish autónomo bookkeeping",
};

// Every page in this app reads from SQLite (via the root layout's palette
// query and per-page queries) and is per-user behind auth. Prerendering at
// build time is impossible (no DB in the container at `next build`) and
// pointless (different users / per-request state). Force dynamic so the
// build container doesn't try to open the DB.
export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const settings = await prisma.settings.findUnique({
    where: { id: 1 },
    select: { accentPalette: true },
  });
  const scale = resolvePalette(settings?.accentPalette);
  return (
    <html lang="en" className={`${geistSans.variable} h-full antialiased`}>
      <head>
        <style dangerouslySetInnerHTML={{ __html: paletteCss(scale) }} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
