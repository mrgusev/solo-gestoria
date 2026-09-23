import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import SmtpAuthFields from "./SmtpAuthFields";
import { prisma } from "@/lib/db";
import { eur } from "@/lib/money";
import { pctToRate, rateToPct } from "@/lib/invoice-totals";
import { utilityDeductiblePct } from "@/lib/deduction";
import { recomputeAllExpenseDeductions } from "@/lib/recompute";
import { PALETTE_NAMES, PALETTES, DEFAULT_PALETTE } from "@/lib/palettes";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import type { Settings } from "@prisma/client";
import { verifySmtp } from "@/lib/email";
import { formatIban, treatmentRuleLabel } from "@/lib/bank-accounts";
import { listBankAccounts } from "@/lib/bank-accounts-db";
import {
  buildConsentUrl,
  defaultRedirectUri,
  exchangeCodeForRefreshToken,
  OAUTH_CALLBACK_PATH,
} from "@/lib/google-oauth";

async function updateSettings(formData: FormData): Promise<void> {
  "use server";
  const homeOfficePct = Number(formData.get("homeOfficePct") ?? 30);
  const retaEur = Number(formData.get("retaMonthlyCuotaEur") ?? 0);
  const hourlyEur = Number(formData.get("defaultHourlyRateEur") ?? 0);
  const lineDesc = String(formData.get("defaultLineDescription") ?? "");
  const exemption = String(formData.get("vatExemptionFootnote") ?? "");
  const vatPct = Number(formData.get("defaultVatRatePct") ?? 21);
  const irpfPct = Number(formData.get("defaultIrpfRetentionPct") ?? 15);
  const irpfNote = String(formData.get("irpfRetentionNote") ?? "");
  const invoiceYear = Number(formData.get("invoiceNumberYear") ?? new Date().getFullYear());
  const invoiceSeq = Number(formData.get("invoiceNumberSeq") ?? 1);
  const telegramBotTokenRaw = String(formData.get("telegramBotToken") ?? "").trim();
  const telegramChatIds = String(formData.get("telegramAllowedChatIds") ?? "").trim();
  const accentPaletteRaw = String(formData.get("accentPalette") ?? DEFAULT_PALETTE);
  const accentPalette = (PALETTE_NAMES as string[]).includes(accentPaletteRaw)
    ? accentPaletteRaw
    : DEFAULT_PALETTE;

  await prisma.settings.update({
    where: { id: 1 },
    data: {
      homeOfficePct: clamp(homeOfficePct, 0, 100),
      retaMonthlyCuotaCents: Math.round(retaEur * 100),
      defaultHourlyRateCents: Math.round(hourlyEur * 100),
      defaultLineDescription: lineDesc,
      vatExemptionFootnote: exemption,
      defaultVatRate: pctToRate(clampPct(vatPct)),
      defaultIrpfRetentionRate: pctToRate(clampPct(irpfPct)),
      irpfRetentionNote: irpfNote,
      invoiceNumberYear: invoiceYear,
      invoiceNumberSeq: invoiceSeq,
      accentPalette,
      // Empty token submission means "keep existing" — never wipe the token by accident.
      ...(telegramBotTokenRaw.length > 0 ? { telegramBotToken: telegramBotTokenRaw } : {}),
      telegramAllowedChatIds: telegramChatIds.length > 0 ? telegramChatIds : null,
      ...readSmtpForm(formData),
    },
  });
  // Re-apply category-driven deduction rules to all confirmed expenses so
  // changes to homeOfficePct propagate to historical utility bills.
  await recomputeAllExpenseDeductions();
  // "layout" scope on "/" revalidates the root layout — needed so the
  // accent-palette <style> tag is re-emitted with the new selection.
  revalidatePath("/", "layout");
  revalidatePath("/settings");
  revalidatePath("/expenses");
  revalidatePath("/reports", "layout");
}

// SMTP half of the settings form.
//
// Two rules here, both about not destroying credentials by accident:
//   - Secrets submit empty when untouched, so blank means "keep the stored
//     value" (same as the bot token).
//   - Only one auth block is on screen at a time, so a field that is *absent*
//     from the FormData was never rendered — leave it alone. Only a field that
//     is present and empty means "clear it".
function readSmtpForm(formData: FormData) {
  const text = (key: string) => String(formData.get(key) ?? "").trim();
  const rendered = (key: string) => formData.has(key);
  // Present-and-empty clears; absent keeps whatever is stored.
  const nullable = (key: string) => (rendered(key) ? { [key]: text(key) || null } : {});
  // Secrets additionally treat present-and-empty as "keep".
  const secret = (key: string) => (text(key).length > 0 ? { [key]: text(key) } : {});
  const port = Number(formData.get("smtpPort") ?? 587);
  return {
    smtpHost: text("smtpHost") || null,
    smtpPort: Number.isFinite(port) ? clamp(port, 1, 65535) : 587,
    smtpSecure: formData.get("smtpSecure") != null,
    smtpUser: text("smtpUser") || null,
    smtpAuthType: text("smtpAuthType") === "OAUTH2" ? "OAUTH2" : "PASSWORD",
    ...secret("smtpPassword"),
    ...nullable("googleClientId"),
    ...secret("googleClientSecret"),
    ...nullable("googleRedirectUri"),
    smtpFromName: text("smtpFromName") || null,
    smtpFromEmail: text("smtpFromEmail") || null,
    smtpReplyTo: text("smtpReplyTo") || null,
    smtpBccSelf: formData.get("smtpBccSelf") != null,
  };
}

// Authenticate against the mail server without sending anything, so a wrong
// App Password surfaces here rather than on the first real invoice. Verifies
// what's in the form, including unsaved edits.
async function testSmtpConnection(formData: FormData): Promise<void> {
  "use server";
  const stored = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!stored) redirect("/settings?smtp=error&msg=" + encodeURIComponent("Run db:seed first"));
  const candidate: Settings = { ...stored, ...readSmtpForm(formData) };
  let error: string | null = null;
  try {
    await verifySmtp(candidate);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  redirect(
    error
      ? `/settings?smtp=error&msg=${encodeURIComponent(error)}`
      : `/settings?smtp=ok&msg=${encodeURIComponent(candidate.smtpUser ?? "")}`
  );
}

// The origin a browser actually reached us on — the standalone server sees its
// own bind address, so the forwarded headers are the only reliable source.
async function requestOrigin(): Promise<string> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3010";
  return `${proto}://${host}`;
}

// Save what's in the form, then bounce to Google's consent screen. Saving
// first matters: the callback needs the client secret and the exact redirect
// URI to complete the exchange.
async function connectGoogle(formData: FormData): Promise<void> {
  "use server";
  const smtp = readSmtpForm(formData);
  await prisma.settings.update({ where: { id: 1 }, data: { ...smtp, smtpAuthType: "OAUTH2" } });
  const stored = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!stored?.googleClientId) {
    redirect(
      "/settings?google=error&msg=" + encodeURIComponent("Enter the OAuth client ID first")
    );
  }
  const redirectUri = stored.googleRedirectUri ?? defaultRedirectUri(await requestOrigin());
  redirect(
    buildConsentUrl({
      clientId: stored.googleClientId,
      redirectUri,
      loginHint: stored.smtpUser ?? undefined,
    })
  );
}

// Fallback for installs Google won't redirect to (a plain-HTTP LAN address is
// neither https nor localhost, so it can't be registered): the user copies the
// ?code= out of the failed callback URL and pastes it here.
async function submitGoogleCode(formData: FormData): Promise<void> {
  "use server";
  const code = String(formData.get("googleCode") ?? "").trim();
  const stored = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!code || !stored?.googleClientId || !stored.googleClientSecret) {
    redirect(
      "/settings?google=error&msg=" +
        encodeURIComponent("Need a client ID, a client secret and a pasted code")
    );
  }
  let error: string | null = null;
  try {
    const { refreshToken } = await exchangeCodeForRefreshToken({
      clientId: stored.googleClientId,
      clientSecret: stored.googleClientSecret,
      code,
      redirectUri: stored.googleRedirectUri ?? defaultRedirectUri(await requestOrigin()),
    });
    await prisma.settings.update({
      where: { id: 1 },
      data: { googleRefreshToken: refreshToken, smtpAuthType: "OAUTH2" },
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  redirect(error ? `/settings?google=error&msg=${encodeURIComponent(error)}` : "/settings?google=ok");
}

async function disconnectGoogle(): Promise<void> {
  "use server";
  await prisma.settings.update({
    where: { id: 1 },
    data: { googleRefreshToken: null, smtpAuthType: "PASSWORD" },
  });
  redirect("/settings?google=disconnected");
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

// Percentages keep their decimals (5.2% is a valid rate), only the range is enforced.
function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ smtp?: string; msg?: string; google?: string }>;
}) {
  const { smtp, msg, google } = await searchParams;
  const [s, origin, bankAccounts] = await Promise.all([
    prisma.settings.findUnique({ where: { id: 1 } }),
    requestOrigin(),
    listBankAccounts(),
  ]);
  if (!s) {
    return (
      <>
        <PageHeader title="Settings" />
        <div className="p-6 text-sm text-red-600">
          Settings not initialized. Run <code>npm run db:seed</code>.
        </div>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Settings"
        description="Issuer details, defaults, and deduction rules."
      />
      {smtp === "ok" ? (
        <div className="mx-6 mt-6 rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900">
          ✅ SMTP login succeeded{msg ? ` as ${msg}` : ""}. Invoices can be emailed.
        </div>
      ) : null}
      {smtp === "error" ? (
        <div className="mx-6 mt-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          ⚠️ SMTP login failed: {msg ?? "unknown error"}
        </div>
      ) : null}
      {google === "ok" ? (
        <div className="mx-6 mt-6 rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900">
          ✅ Google account connected. Hit <b>Test connection</b> below to confirm Gmail accepts
          the token.
        </div>
      ) : null}
      {google === "disconnected" ? (
        <div className="mx-6 mt-6 rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-700">
          Google account disconnected. Revoke the grant itself at{" "}
          <a
            className="underline"
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noreferrer"
          >
            myaccount.google.com/permissions
          </a>
          .
        </div>
      ) : null}
      {google === "error" ? (
        <div className="mx-6 mt-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          ⚠️ Google sign-in failed: {msg ?? "unknown error"}
        </div>
      ) : null}
      <form action={updateSettings} className="p-6 max-w-2xl space-y-6">
        <Section title="Bookkeeping defaults">
          <Field
            name="homeOfficePct"
            label="Business-use area of home (%)"
            type="number"
            defaultValue={String(s.homeOfficePct)}
            min={0}
            max={100}
            hint={`The % of your home's m² declared to Hacienda as used for the activity. Spanish law (art. 30.5.b Ley 35/2006) lets you deduct 30% of utility bills proportional to this area — currently ${utilityDeductiblePct(s)}% of each electricity, internet, water, and gas bill (net + VAT) at your ${s.homeOfficePct}% area.`}
          />
          <Field
            name="retaMonthlyCuotaEur"
            label="RETA monthly cuota (€)"
            type="number"
            step="0.01"
            defaultValue={eur(s.retaMonthlyCuotaCents).toFixed(2)}
            hint="100% IRPF-deductible. The bot worker creates one SOCIAL_SECURITY expense on the last day of each month."
          />
          <Field
            name="defaultHourlyRateEur"
            label="Default hourly rate (€)"
            type="number"
            step="0.01"
            defaultValue={eur(s.defaultHourlyRateCents).toFixed(2)}
          />
          <Field
            name="defaultLineDescription"
            label="Default invoice line description"
            defaultValue={s.defaultLineDescription}
          />
          <Field
            name="vatExemptionFootnote"
            label="VAT-exempt footnote text"
            defaultValue={s.vatExemptionFootnote}
            multiline
          />
        </Section>

        <Section title="Spanish clients (defaults)">
          <p className="text-xs text-neutral-500">
            These only pre-fill the form when you add a client at{" "}
            <a href="/clients" className="underline">
              /clients
            </a>
            . Each client stores its own rates, and every invoice snapshots them at
            issue time — changing these never alters an existing client or invoice.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field
              name="defaultVatRatePct"
              label="Default IVA rate (%)"
              type="number"
              step="0.01"
              min={0}
              max={100}
              defaultValue={String(rateToPct(s.defaultVatRate))}
              hint="21 general · 10 reducido · 4 superreducido."
            />
            <Field
              name="defaultIrpfRetentionPct"
              label="Default IRPF retention (%)"
              type="number"
              step="0.01"
              min={0}
              max={100}
              defaultValue={String(rateToPct(s.defaultIrpfRetentionRate))}
              hint="15 standard · 7 during the first 3 years of activity."
            />
          </div>
          <Field
            name="irpfRetentionNote"
            label="IRPF retention footnote (Spanish facturas)"
            defaultValue={s.irpfRetentionNote}
            multiline
          />
        </Section>

        <Section title="Invoice numbering">
          <div className="grid grid-cols-2 gap-3">
            <Field
              name="invoiceNumberYear"
              label="Year"
              type="number"
              defaultValue={String(s.invoiceNumberYear)}
            />
            <Field
              name="invoiceNumberSeq"
              label="Next sequence"
              type="number"
              defaultValue={String(s.invoiceNumberSeq)}
              hint={`Next invoice number: FACT-${s.invoiceNumberYear}-${String(s.invoiceNumberSeq).padStart(5, "0")}`}
            />
          </div>
        </Section>

        <Section title="Appearance">
          <label className="block">
            <span className="text-sm font-medium">Accent palette</span>
            <select
              name="accentPalette"
              defaultValue={s.accentPalette}
              className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
            >
              {PALETTE_NAMES.map((name) => (
                <option key={name} value={name}>
                  {name[0].toUpperCase() + name.slice(1)}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-neutral-500">
              Drives buttons, active tabs, and focus rings across the app. Changes apply after saving.
            </p>
          </label>
          <div className="flex flex-wrap gap-3 pt-1">
            {PALETTE_NAMES.map((name) => {
              const scale = PALETTES[name];
              const active = s.accentPalette === name;
              return (
                <div
                  key={name}
                  className={`rounded-md border px-2 py-1.5 text-[11px] ${
                    active ? "border-neutral-400 bg-neutral-50" : "border-neutral-200"
                  }`}
                >
                  <div className="flex items-center gap-1">
                    <span className="h-3 w-3 rounded" style={{ background: scale[300] }} />
                    <span className="h-3 w-3 rounded" style={{ background: scale[500] }} />
                    <span className="h-3 w-3 rounded" style={{ background: scale[700] }} />
                  </div>
                  <div className="mt-0.5 text-neutral-600">{name}</div>
                </div>
              );
            })}
          </div>
        </Section>

        <Section title="Telegram bot">
          <Field
            name="telegramBotToken"
            label="Bot token (from @BotFather)"
            type="password"
            defaultValue=""
            hint={
              s.telegramBotToken
                ? `Stored (••••${s.telegramBotToken.slice(-4)}). Leave blank to keep, or paste a new token to replace.`
                : "Get one by messaging @BotFather → /newbot. The token is stored in the local SQLite DB only."
            }
          />
          <Field
            name="telegramAllowedChatIds"
            label="Allowed chat IDs"
            defaultValue={s.telegramAllowedChatIds ?? ""}
            hint="Comma-separated Telegram user IDs that the bot will respond to. Get yours from @userinfobot."
          />
          <p className="text-xs text-neutral-500">
            Start the worker with{" "}
            <code className="rounded bg-neutral-100 px-1 py-0.5">npm run bot</code> in a
            separate terminal. The bot accepts text messages and PDF expense receipts.
          </p>
        </Section>

        <Section title="Email (SMTP)">
          <p className="text-xs text-neutral-500">
            Used to email invoices to clients, including the ones the recurring schedules
            generate. For Gmail: host <code className="rounded bg-neutral-100 px-1 py-0.5">smtp.gmail.com</code>,
            port 587, username your full address, and a 16-character{" "}
            <a
              className="underline"
              href="https://myaccount.google.com/apppasswords"
              target="_blank"
              rel="noreferrer"
            >
              App Password
            </a>{" "}
            (2-Step Verification must be on — Google rejects normal passwords over SMTP).
          </p>
          <div className="grid grid-cols-2 gap-4">
            <Field name="smtpHost" label="Host" defaultValue={s.smtpHost ?? ""} />
            <Field
              name="smtpPort"
              label="Port"
              type="number"
              min={1}
              max={65535}
              defaultValue={String(s.smtpPort)}
              hint="587 for STARTTLS, 465 for implicit TLS."
            />
          </div>
          <Field
            name="smtpUser"
            label="Username"
            defaultValue={s.smtpUser ?? ""}
            hint="Usually the full mailbox address."
          />
          <SmtpAuthFields
            initialMode={s.smtpAuthType}
            passwordFields={
              <Field
                name="smtpPassword"
                label="Password"
                type="password"
                defaultValue=""
                hint={
                  s.smtpPassword
                    ? "Stored. Leave blank to keep it, or paste a new one to replace."
                    : "Gmail: paste the App Password with no spaces."
                }
              />
            }
            googleFields={
              <div className="rounded-md border border-neutral-200 bg-neutral-50 p-4 space-y-4">
                {s.googleRefreshToken ? (
                  <div className="flex flex-wrap items-center gap-3 rounded-md border border-green-200 bg-green-50 px-3 py-2">
                    <span className="text-sm text-green-900">
                      ✅ Google account connected{s.smtpUser ? ` as ${s.smtpUser}` : ""}
                    </span>
                    <button
                      type="submit"
                      formAction={disconnectGoogle}
                      className="rounded-md border border-red-200 bg-white px-3 py-1 text-xs text-red-700 hover:bg-red-50"
                    >
                      Disconnect
                    </button>
                  </div>
                ) : null}

                <ol className="list-decimal space-y-2 pl-5 text-xs text-neutral-600 marker:font-semibold marker:text-neutral-500">
                  <li>
                    In{" "}
                    <a
                      className="underline"
                      href="https://console.cloud.google.com/auth/overview"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Google Auth Platform
                    </a>{" "}
                    set the app&apos;s <b>Audience</b> to <b>Internal</b>. Workspace domains only —
                    it means no app verification, and refresh tokens that never expire.
                  </li>
                  <li>
                    Under{" "}
                    <a
                      className="underline"
                      href="https://console.cloud.google.com/apis/credentials"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Credentials
                    </a>{" "}
                    → Create credentials → <b>OAuth client ID</b> → application type{" "}
                    <b>Web application</b>.
                  </li>
                  <li>
                    In that client, add this exact string under{" "}
                    <i>Authorized redirect URIs</i>:
                    <code className="mt-1 block break-all rounded bg-white px-2 py-1 font-mono text-[11px] text-neutral-800 ring-1 ring-neutral-200">
                      {s.googleRedirectUri || defaultRedirectUri(origin)}
                    </code>
                    {defaultRedirectUri(origin).startsWith("http://") &&
                    !defaultRedirectUri(origin).startsWith("http://localhost") &&
                    !defaultRedirectUri(origin).startsWith("http://127.0.0.1") ? (
                      <span className="mt-1 block text-amber-700">
                        ⚠️ Google rejects plain-HTTP redirect URIs unless they&apos;re localhost.
                        You reached this page over HTTP, so put{" "}
                        <code className="rounded bg-white px-1">
                          http://localhost:3010{OAUTH_CALLBACK_PATH}
                        </code>{" "}
                        in the Redirect URI field below and use the paste-the-code step at the
                        bottom.
                      </span>
                    ) : null}
                  </li>
                  <li>
                    Enable the{" "}
                    <a
                      className="underline"
                      href="https://console.cloud.google.com/apis/library/gmail.googleapis.com"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Gmail API
                    </a>{" "}
                    for the project.
                  </li>
                  <li>Paste the client ID and secret below, then press Connect.</li>
                </ol>
                <p className="text-xs text-neutral-600">
                  The only permission requested is{" "}
                  <code className="rounded bg-white px-1 py-0.5">gmail.send</code> — this app can
                  send mail as you and nothing else. It cannot read, search, label or delete
                  anything in the mailbox. Host and port are ignored in this mode: messages go
                  through the Gmail API, which also files its own copy in <i>Sent</i>.
                </p>

                <Field name="googleClientId" label="Client ID" defaultValue={s.googleClientId ?? ""} />
                <Field
                  name="googleClientSecret"
                  label="Client secret"
                  type="password"
                  defaultValue=""
                  hint={
                    s.googleClientSecret
                      ? "Stored. Leave blank to keep it."
                      : "From the same OAuth client."
                  }
                />
                <Field
                  name="googleRedirectUri"
                  label="Redirect URI (optional override)"
                  defaultValue={s.googleRedirectUri ?? ""}
                  hint={`Leave blank to use ${defaultRedirectUri(origin)}.`}
                />

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="submit"
                    formAction={connectGoogle}
                    className="rounded-md bg-accent-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-600"
                  >
                    {s.googleRefreshToken ? "Reconnect Google account" : "Connect Google account"}
                  </button>
                  <span className="text-xs text-neutral-500">
                    Saves this form, then sends you to Google&apos;s consent screen.
                  </span>
                </div>

                <details className="text-xs text-neutral-600">
                  <summary className="cursor-pointer">
                    Consent finished on a page that wouldn&apos;t load? Paste the code here
                  </summary>
                  <p className="mt-2">
                    The address bar of that failed page contains{" "}
                    <code className="rounded bg-white px-1 py-0.5">code=…&amp;</code> — copy
                    everything between <code className="rounded bg-white px-1 py-0.5">code=</code>{" "}
                    and the next <code className="rounded bg-white px-1 py-0.5">&amp;</code>.
                  </p>
                  <div className="mt-2 flex items-end gap-2">
                    <label className="block flex-1">
                      <span className="text-xs font-medium text-neutral-700">
                        Authorization code
                      </span>
                      <input
                        name="googleCode"
                        type="text"
                        defaultValue=""
                        className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
                      />
                    </label>
                    <button
                      type="submit"
                      formAction={submitGoogleCode}
                      className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
                    >
                      Exchange
                    </button>
                  </div>
                </details>
              </div>
            }
          />
          <div className="grid grid-cols-2 gap-4">
            <Field name="smtpFromName" label="From name" defaultValue={s.smtpFromName ?? ""} />
            <Field
              name="smtpFromEmail"
              label="From address"
              type="email"
              defaultValue={s.smtpFromEmail ?? ""}
              hint="Defaults to the username. Gmail rewrites this unless it's a verified alias."
            />
          </div>
          <Field
            name="smtpReplyTo"
            label="Reply-to (optional)"
            type="email"
            defaultValue={s.smtpReplyTo ?? ""}
          />
          <Checkbox
            name="smtpSecure"
            label="Implicit TLS (port 465)"
            defaultChecked={s.smtpSecure}
            hint="Leave off for port 587 — STARTTLS is negotiated automatically."
          />
          <Checkbox
            name="smtpBccSelf"
            label="Bcc myself on every invoice"
            defaultChecked={s.smtpBccSelf}
            hint="SMTP sends don't appear in Gmail's Sent folder, so this keeps you a copy."
          />
          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              formAction={testSmtpConnection}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
            >
              Test connection
            </button>
            <span className="text-xs text-neutral-500">
              Logs in and disconnects — no email is sent. Doesn&apos;t save the form.
            </span>
          </div>
        </Section>

        <Section title="Issuer (read-only)">
          <ReadField label="Name" value={s.issuerName} />
          <ReadField label="NIF" value={s.issuerTaxId} />
          <ReadField label="VAT ID" value={s.issuerVatId} />
          <ReadField
            label="Address"
            value={`${s.issuerAddressLine}, ${s.issuerPostalCode} ${s.issuerCity}, ${s.issuerCountry}`}
          />
          <ReadField label="Phone" value={s.issuerPhone ?? "—"} />
          <p className="text-xs text-neutral-500">
            Edit via{" "}
            <code className="rounded bg-neutral-100 px-1 py-0.5">prisma/seed.ts</code>{" "}
            and re-run <code className="rounded bg-neutral-100 px-1 py-0.5">npm run db:seed</code>{" "}
            for now.
          </p>
        </Section>

        <Section title="Bank accounts">
          {bankAccounts.length === 0 ? (
            <p className="text-sm text-neutral-600">
              None configured — invoices fall back to the legacy details ({formatIban(s.bankIban)}).
            </p>
          ) : (
            <ul className="space-y-2">
              {bankAccounts.map((a) => (
                <li key={a.id} className="text-sm">
                  <span className="font-medium">{a.label}</span>{" "}
                  <span className="tabular-nums text-neutral-600">{formatIban(a.iban)}</span>
                  <div className="text-xs text-neutral-500">
                    {a.isDefault ? "Fallback for every invoice. " : ""}
                    {a.defaultForTreatments
                      ? `Default for: ${treatmentRuleLabel(a.defaultForTreatments)}. `
                      : ""}
                    {a.useForAeat ? "Used on the AEAT ficheros." : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <Link
            href="/settings/bank-accounts"
            className="inline-block rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            Manage bank accounts
          </Link>
        </Section>

        <div className="pt-2">
          <button
            type="submit"
            className="rounded-md bg-accent-500 px-4 py-2 text-sm font-medium text-white hover:bg-accent-600"
          >
            Save settings
          </button>
        </div>
      </form>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-neutral-200 bg-white">
      <div className="border-b border-neutral-200 px-4 py-2.5">
        <h2 className="text-sm font-medium">{title}</h2>
      </div>
      <div className="p-4 space-y-4">{children}</div>
    </section>
  );
}

function Field({
  name,
  label,
  defaultValue,
  type = "text",
  step,
  min,
  max,
  hint,
  multiline,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  type?: string;
  step?: string;
  min?: number;
  max?: number;
  hint?: string;
  multiline?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-neutral-700">{label}</span>
      {multiline ? (
        <textarea
          name={name}
          defaultValue={defaultValue}
          rows={3}
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
        />
      ) : (
        <input
          name={name}
          type={type}
          step={step}
          min={min}
          max={max}
          defaultValue={defaultValue}
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
        />
      )}
      {hint ? <span className="mt-1 block text-xs text-neutral-500">{hint}</span> : null}
    </label>
  );
}

function Checkbox({
  name,
  label,
  defaultChecked,
  hint,
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="flex items-center gap-2">
        <input
          name={name}
          type="checkbox"
          defaultChecked={defaultChecked}
          className="h-4 w-4 rounded border-neutral-300"
        />
        <span className="text-sm font-medium text-neutral-700">{label}</span>
      </span>
      {hint ? <span className="mt-1 block text-xs text-neutral-500">{hint}</span> : null}
    </label>
  );
}

function ReadField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  );
}
