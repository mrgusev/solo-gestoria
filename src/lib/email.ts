// Outbound email — invoices to clients, over SMTP.
//
// Config lives in Settings (not env) so it can be edited from the Settings page
// like the Telegram token. With Gmail: host smtp.gmail.com, port 587, user =
// the full address, password = a 16-char App Password (Google refuses plain
// account passwords over SMTP since 2022). The From address must be either the
// authenticated account or an alias verified under Gmail's "Send mail as",
// otherwise Google silently rewrites the header.

import nodemailer from "nodemailer";
import type { Settings } from "@prisma/client";
import { prisma } from "./db";
import { formatEUR } from "./money";

export type SmtpConfig = Pick<
  Settings,
  | "smtpHost"
  | "smtpPort"
  | "smtpSecure"
  | "smtpUser"
  | "smtpPassword"
  | "smtpAuthType"
  | "googleClientId"
  | "googleClientSecret"
  | "googleRefreshToken"
  | "smtpFromName"
  | "smtpFromEmail"
  | "smtpReplyTo"
  | "smtpBccSelf"
>;

export function usesOAuth(s: Pick<SmtpConfig, "smtpAuthType">): boolean {
  return s.smtpAuthType === "OAUTH2";
}

export class EmailNotConfiguredError extends Error {
  constructor(public detail: string) {
    super(`SMTP not configured: ${detail}`);
    this.name = "EmailNotConfiguredError";
  }
}

export function isEmailConfigured(s: SmtpConfig): boolean {
  if (!fromAddress(s)) return false;
  // OAuth mode posts to the Gmail API, so it needs no host or port — just a
  // connected account and an address to send as.
  return usesOAuth(s)
    ? Boolean(s.googleClientId && s.googleClientSecret && s.googleRefreshToken)
    : Boolean(s.smtpHost && s.smtpUser && s.smtpPassword);
}

// The address invoices are sent from. Falls back to the SMTP username, which
// for Gmail and most providers is the mailbox address itself.
function fromAddress(s: SmtpConfig): string | null {
  const addr = (s.smtpFromEmail ?? s.smtpUser ?? "").trim();
  return addr.length > 0 ? addr : null;
}

function fromHeader(s: SmtpConfig): string {
  const addr = fromAddress(s)!;
  const name = (s.smtpFromName ?? "").trim();
  return name.length > 0 ? `${name} <${addr}>` : addr;
}

// Split out from transportFor so the credential wiring can be asserted in
// tests without opening a socket. SMTP only — OAuth mode never builds one of
// these, because it talks to the Gmail API instead (see sendMail below).
export function smtpTransportOptions(s: SmtpConfig) {
  if (usesOAuth(s)) {
    // Guard rather than silently building a password transport with an
    // undefined password: OAuth sends must go through the Gmail API, because
    // the send-only scope is not valid for SMTP.
    throw new EmailNotConfiguredError("OAuth2 mode sends through the Gmail API, not SMTP");
  }
  if (!isEmailConfigured(s)) {
    throw new EmailNotConfiguredError(
      "host, user, password and a from address are all required"
    );
  }
  return {
    host: s.smtpHost!,
    port: s.smtpPort,
    // Implicit TLS on 465; everything else negotiates STARTTLS on connect.
    secure: s.smtpSecure || s.smtpPort === 465,
    auth: { user: s.smtpUser!, pass: s.smtpPassword! },
  };
}

function transportFor(s: SmtpConfig) {
  return nodemailer.createTransport(smtpTransportOptions(s));
}

export type MailPayload = {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string;
  replyTo?: string;
  subject: string;
  text: string;
  attachments: { filename: string; content: Buffer; contentType: string }[];
};

// One send, either route. SMTP hands the message to nodemailer's transport;
// OAuth builds the same MIME document and POSTs it to Gmail, which is the only
// way to send under the send-only scope.
async function sendMail(s: SmtpConfig, payload: MailPayload): Promise<string> {
  if (!isEmailConfigured(s)) {
    throw new EmailNotConfiguredError(
      usesOAuth(s)
        ? "a from address and a connected Google account are both required"
        : "host, user, password and a from address are all required"
    );
  }

  if (usesOAuth(s)) {
    const { fetchAccessToken, gmailSend } = await import("./google-oauth");
    const { accessToken } = await fetchAccessToken({
      clientId: s.googleClientId!,
      clientSecret: s.googleClientSecret!,
      refreshToken: s.googleRefreshToken!,
    });
    const MailComposer = (await import("nodemailer/lib/mail-composer")).default;
    const raw = await new MailComposer({
      ...payload,
      // Gmail files its own copy in Sent, so the Bcc-to-self that SMTP needs
      // would just duplicate the message in the mailbox.
      bcc: undefined,
    }).compile().build();
    const { id } = await gmailSend({ accessToken, rawMessage: raw });
    return id;
  }

  const transport = transportFor(s);
  try {
    const info = await transport.sendMail(payload);
    return info.messageId;
  } finally {
    transport.close();
  }
}

// Prove the credentials work without sending anything — backs the "Test
// connection" button on the Settings page, so a wrong App Password or a
// revoked Google grant surfaces there instead of on the first real invoice.
export async function verifySmtp(s: SmtpConfig): Promise<void> {
  if (usesOAuth(s)) {
    if (!isEmailConfigured(s)) {
      throw new EmailNotConfiguredError(
        "a from address and a connected Google account are both required"
      );
    }
    const { fetchAccessToken, GMAIL_SEND_SCOPE } = await import("./google-oauth");
    // Redeeming the refresh token is the real check: it fails loudly if the
    // grant was revoked or (on an External/Testing client) has expired.
    const { scope } = await fetchAccessToken({
      clientId: s.googleClientId!,
      clientSecret: s.googleClientSecret!,
      refreshToken: s.googleRefreshToken!,
    });
    if (scope && !scope.split(/\s+/).includes(GMAIL_SEND_SCOPE)) {
      throw new Error(
        `The Google grant is missing the ${GMAIL_SEND_SCOPE} scope (got: ${scope}). Reconnect the account.`
      );
    }
    return;
  }
  const transport = transportFor(s);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

// Split a comma/semicolon-separated recipient string into addresses.
export function parseRecipients(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

export function looksLikeEmail(addr: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
}

type InvoiceEmailCopy = { subject: string; text: string };

// Body text in the invoice's own language — a Spanish client gets a Spanish
// covering note, matching the factura template it's attached to.
function composeCopy(args: {
  locale: string;
  number: string;
  issuerName: string;
  totalCents: number;
  dueDate: Date;
}): InvoiceEmailCopy {
  const total = formatEUR(args.totalCents);
  const due = args.dueDate.toISOString().slice(0, 10);
  if (args.locale === "es") {
    return {
      subject: `Factura ${args.number} — ${args.issuerName}`,
      text:
        `Hola,\n\n` +
        `Adjunto la factura ${args.number} por importe de ${total}, con vencimiento el ${due}.\n\n` +
        `Quedo a su disposición para cualquier aclaración.\n\n` +
        `Un saludo,\n${args.issuerName}\n`,
    };
  }
  return {
    subject: `Invoice ${args.number} from ${args.issuerName}`,
    text:
      `Hello,\n\n` +
      `Please find attached invoice ${args.number} for ${total}, due on ${due}.\n\n` +
      `Let me know if anything needs clarifying.\n\n` +
      `Best regards,\n${args.issuerName}\n`,
  };
}

export type SendInvoiceEmailResult = {
  to: string[];
  cc: string[];
  messageId: string;
};

// Render the invoice PDF and email it to the client. Recipients default to the
// client's own address; `to`/`cc` override (the recurring schedule carries its
// own billing contacts). Records the delivery on the Invoice row so the UI can
// show what has already gone out.
export async function sendInvoiceEmail(args: {
  invoiceId: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  text?: string;
}): Promise<SendInvoiceEmailResult> {
  const [invoice, settings] = await Promise.all([
    prisma.invoice.findUnique({
      where: { id: args.invoiceId },
      include: { lines: { orderBy: { position: "asc" } }, client: true, bankAccount: true },
    }),
    prisma.settings.findUnique({ where: { id: 1 } }),
  ]);
  if (!invoice) throw new Error(`Invoice ${args.invoiceId} not found`);
  if (!settings) throw new Error("Settings missing — run db:seed");

  const to = (args.to?.length ? args.to : parseRecipients(invoice.client.email)).filter(
    looksLikeEmail
  );
  if (to.length === 0) {
    throw new Error(
      `No recipient for invoice ${invoice.number}: client "${invoice.client.name}" has no email address.`
    );
  }
  const cc = (args.cc ?? []).filter(looksLikeEmail);

  const copy = composeCopy({
    locale: invoice.locale,
    number: invoice.number,
    issuerName: settings.issuerName,
    totalCents: invoice.totalCents,
    dueDate: invoice.dueDate,
  });

  // Render fresh rather than trusting the file on disk — an edit since the last
  // persist would otherwise mail a stale PDF.
  const { renderInvoicePdf } = await import("./invoice-pdf");
  const pdf = await renderInvoicePdf({ invoice, settings });

  const messageId = await sendMail(settings, {
    from: fromHeader(settings),
    to,
    cc: cc.length > 0 ? cc : undefined,
    // Keeping a copy in the issuer's own mailbox is the cheap audit trail —
    // Gmail's Sent folder doesn't get one for mail sent over SMTP. (Ignored on
    // the Gmail API route, which files a Sent copy by itself.)
    bcc: settings.smtpBccSelf ? fromAddress(settings)! : undefined,
    replyTo: settings.smtpReplyTo?.trim() || undefined,
    subject: args.subject ?? copy.subject,
    text: args.text ?? copy.text,
    attachments: [
      { filename: `${invoice.number}.pdf`, content: pdf, contentType: "application/pdf" },
    ],
  });
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { emailedAt: new Date(), emailedTo: [...to, ...cc].join(", ") },
  });
  return { to, cc, messageId };
}
