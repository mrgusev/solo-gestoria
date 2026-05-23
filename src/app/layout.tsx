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
