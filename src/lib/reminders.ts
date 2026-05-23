// Scheduled deadline reminders for the Spanish autónomo calendar.
//
// The bot worker calls `dueReminders()` on boot and once per hour. Each
// reminder has an "active window" of dates during which it should fire if
// not yet sent. Once sent, a row in SentReminder dedupes it forever.
//
// Calendar:
//   - Quarter-end recap:  1st-5th of Apr / Jul / Oct / Jan
//   - Filing T-7 nudge:   13th-15th of Apr / Jul / Oct  ·  23rd-25th of Jan
//   - Filing T-2 final:   18th-19th of Apr / Jul / Oct  ·  28th-29th of Jan
//   - Renta campaign open:  1-7 Apr (for prior year)
//   - Renta T-7:          23-29 Jun (for prior year)
//   - MOD 390 annual:     10-20 Jan (for prior year)

import { prisma } from "./db";
import { computeQuarterReport, type Quarter } from "./tax";
import { formatEUR } from "./money";

export type Reminder = {
  kind: string;
  refKey: string;
  text: string;
};

// Look at today's date and emit every reminder whose active window currently
// contains it. Filters by what's already been sent.
export async function dueReminders(now: Date = new Date()): Promise<Reminder[]> {
  const candidates = computeWindowMatches(now);
  if (candidates.length === 0) return [];
  const sent = await prisma.sentReminder.findMany({
    where: { OR: candidates.map((c) => ({ kind: c.kind, refKey: c.refKey })) },
  });
  const sentKeys = new Set(sent.map((s) => `${s.kind}:${s.refKey}`));
  const out: Reminder[] = [];
  for (const c of candidates) {
    if (sentKeys.has(`${c.kind}:${c.refKey}`)) continue;
    const text = await compose(c);
    if (text) out.push({ kind: c.kind, refKey: c.refKey, text });
  }
  return out;
}

// Compute what next deadline is upcoming, for the /remind status command.
export function upcomingDeadlines(now: Date = new Date()): {
  label: string;
  date: string;          // YYYY-MM-DD
  daysAway: number;
}[] {
  const y = now.getUTCFullYear();
  const items: { label: string; date: Date }[] = [];
  // Quarterly forms (this year + early next)
  for (const [q, [m, d]] of [
    [1, [3, 31]] as const,    // Q1 ends Mar 31
    [2, [6, 30]] as const,    // Q2 ends Jun 30
    [3, [9, 30]] as const,    // Q3 ends Sep 30
  ]) {
    items.push({ label: `Q${q} ${y} ends`, date: new Date(Date.UTC(y, m, d)) });
  }
  items.push({ label: `Q4 ${y} ends`, date: new Date(Date.UTC(y, 11, 31)) });

  for (const [q, [m, d]] of [
    [1, [3, 20]] as const,    // 20 Apr
    [2, [6, 20]] as const,    // 20 Jul
    [3, [9, 20]] as const,    // 20 Oct
  ]) {
    items.push({ label: `Q${q} ${y} forms due (MOD 130/303/349)`, date: new Date(Date.UTC(y, m, d)) });
  }
  // Q4 deadline is Jan 30 of next year
  items.push({ label: `Q4 ${y} forms due (MOD 130/303/349)`, date: new Date(Date.UTC(y + 1, 0, 30)) });
  // MOD 390 annual: 30 Jan next year
  items.push({ label: `MOD 390 (IVA annual) ${y} due`, date: new Date(Date.UTC(y + 1, 0, 30)) });
  // Renta campaign for previous year: Apr 1 - Jun 30 this year
  items.push({ label: `Renta ${y - 1} (MOD 100) due`, date: new Date(Date.UTC(y, 5, 30)) });

  const future = items
    .filter((i) => i.date.getTime() > now.getTime())
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .slice(0, 5);

  return future.map((i) => ({
    label: i.label,
    date: i.date.toISOString().slice(0, 10),
    daysAway: Math.ceil((i.date.getTime() - now.getTime()) / 86400_000),
  }));
}

// Mark a reminder as sent. Caller invokes this after successful delivery.
export async function markSent(kind: string, refKey: string): Promise<void> {
  await prisma.sentReminder.upsert({
    where: { kind_refKey: { kind, refKey } },
    update: { sentAt: new Date() },
    create: { kind, refKey, sentAt: new Date() },
  });
}

// ---- internals ----

type Candidate = {
  kind: string;
  refKey: string;
  year: number;
  quarter?: Quarter;
};

function computeWindowMatches(now: Date): Candidate[] {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 1-12
  const d = now.getUTCDate();
  const out: Candidate[] = [];

  // Quarter-end recap: 1st-5th of Apr / Jul / Oct / Jan
  for (const [endMonth, q] of [
    [4, 1] as const,
    [7, 2] as const,
    [10, 3] as const,
    [1, 4] as const,
  ]) {
    if (m === endMonth && d >= 1 && d <= 5) {
      const refYear = q === 4 ? y - 1 : y;
      out.push({ kind: "quarter_end", refKey: `${refYear}-Q${q}`, year: refYear, quarter: q });
    }
  }

  // Filing T-7: 13-15 Apr/Jul/Oct, 23-25 Jan
  for (const [month, dayStart, dayEnd, q] of [
    [4, 13, 15, 1] as const,
    [7, 13, 15, 2] as const,
    [10, 13, 15, 3] as const,
    [1, 23, 25, 4] as const,
  ]) {
    if (m === month && d >= dayStart && d <= dayEnd) {
      const refYear = q === 4 ? y - 1 : y;
      out.push({ kind: "filing_t7", refKey: `${refYear}-Q${q}`, year: refYear, quarter: q });
    }
  }

  // Filing T-2: 18-19 Apr/Jul/Oct, 28-29 Jan
  for (const [month, dayStart, dayEnd, q] of [
    [4, 18, 19, 1] as const,
    [7, 18, 19, 2] as const,
    [10, 18, 19, 3] as const,
    [1, 28, 29, 4] as const,
  ]) {
    if (m === month && d >= dayStart && d <= dayEnd) {
      const refYear = q === 4 ? y - 1 : y;
      out.push({ kind: "filing_t2", refKey: `${refYear}-Q${q}`, year: refYear, quarter: q });
    }
  }

  // Renta open: 1-7 Apr
  if (m === 4 && d >= 1 && d <= 7) {
    out.push({ kind: "renta_open", refKey: `${y - 1}`, year: y - 1 });
  }
  // Renta T-7: 23-29 Jun
  if (m === 6 && d >= 23 && d <= 29) {
    out.push({ kind: "renta_t7", refKey: `${y - 1}`, year: y - 1 });
  }
  // MOD 390: 10-20 Jan
  if (m === 1 && d >= 10 && d <= 20) {
    out.push({ kind: "mod390", refKey: `${y - 1}`, year: y - 1 });
  }

  return out;
}

async function compose(c: Candidate): Promise<string | null> {
  if (c.kind === "quarter_end" && c.quarter) {
    const r = await computeQuarterReport(c.year, c.quarter);
    const deadline = filingDeadlineFor(c.year, c.quarter);
    return (
      `📊 <b>${c.year} Q${c.quarter} ended</b>\n` +
      `Income: <b>${formatEUR(r.period.incomeCents)}</b>\n` +
      `Deductible: <b>${formatEUR(r.period.deductibleNetCents)}</b> (+ €${(r.period.deductibleVatCents / 100).toFixed(2)} IVA)\n` +
      `Projected MOD 130 payment: <b>${formatEUR(r.mod130.box07)}</b>\n` +
      `\nForms due by <b>${deadline.toISOString().slice(0, 10)}</b>. Open <code>/reports/${c.year}/${c.quarter}</code> when you're ready.`
    );
  }
  if (c.kind === "filing_t7" && c.quarter) {
    const r = await computeQuarterReport(c.year, c.quarter);
    const deadline = filingDeadlineFor(c.year, c.quarter);
    return (
      `⏰ <b>${c.year} Q${c.quarter} filing due in ~7 days</b> — ${deadline.toISOString().slice(0, 10)}\n\n` +
      `MOD 130: pay <b>${formatEUR(r.mod130.box07)}</b>\n` +
      `MOD 303: <b>${formatEUR(r.mod303.box72)}</b> to compensate next quarter\n` +
      `MOD 349: ${r.mod349.length} intra-EU operator${r.mod349.length === 1 ? "" : "s"}, base ${formatEUR(r.mod349.reduce((s, o) => s + o.baseCents, 0))}\n\n` +
      `Have all expenses for the quarter been uploaded? Once filed, invoices in this quarter lock automatically.`
    );
  }
  if (c.kind === "filing_t2" && c.quarter) {
    const deadline = filingDeadlineFor(c.year, c.quarter);
    return (
      `🚨 <b>${c.year} Q${c.quarter} filing due in 2 days</b> — ${deadline.toISOString().slice(0, 10)}\n\n` +
      `Last chance to add receipts. Download AEAT files from the reports page and submit them on Sede Electrónica.`
    );
  }
  if (c.kind === "renta_open") {
    return (
      `🗓️ <b>Renta ${c.year} campaign open</b>\n\n` +
      `MOD 100 due by <b>30 June</b>. This consolidates the four MOD 130 payments you made through ${c.year} and computes your final IRPF. ` +
      `Most autónomos let Hacienda's borrador handle it via Renta WEB.`
    );
  }
  if (c.kind === "renta_t7") {
    return (
      `🚨 <b>Renta ${c.year} due in ~7 days</b> — 30 June\n\n` +
      `If you haven't filed yet, do it via Renta WEB at sede.agenciatributaria.gob.es.`
    );
  }
  if (c.kind === "mod390") {
    return (
      `📋 <b>MOD 390 (IVA annual ${c.year}) due 30 Jan</b>\n\n` +
      `Recaps your four MOD 303 filings for ${c.year}. Usually zero amount due if you only carry-forward IVA each quarter.`
    );
  }
  return null;
}

function filingDeadlineFor(year: number, q: Quarter): Date {
  if (q === 4) return new Date(Date.UTC(year + 1, 0, 30)); // 30 Jan next year
  return new Date(Date.UTC(year, q * 3, 20)); // 20th of month after quarter
}
