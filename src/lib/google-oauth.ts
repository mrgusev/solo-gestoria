// "Sign in with Google" for sending mail — the OAuth2 half of src/lib/email.ts.
//
// Gmail's SMTP server accepts XOAUTH2, so the only thing this module has to do
// is get (and keep) a refresh token. Nodemailer exchanges that for short-lived
// access tokens on its own at send time.
//
// On a Workspace domain, create the OAuth client with user type **Internal**:
// no app verification, and the refresh token doesn't expire. An External
// client left in "Testing" mode expires refresh tokens after 7 days, which
// would silently break the recurring cron a week after setup.

// Send-only. This scope can create and send a message and nothing else: it
// cannot read, list, label, modify or delete mail, so a leaked refresh token
// can't be used to rifle through the mailbox.
//
// It only works against the Gmail API (users.messages.send). Gmail's SMTP
// endpoint refuses it — XOAUTH2 over SMTP demands the full-mailbox
// https://mail.google.com/ scope, which is exactly what we're avoiding. That
// is why OAuth mode posts to the API instead of opening an SMTP connection.
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// Default callback path. Google only accepts https:// redirect URIs, with
// http://localhost and http://127.0.0.1 as the documented exceptions — so a
// LAN-IP install has to use the paste-the-code fallback instead.
export const OAUTH_CALLBACK_PATH = "/api/google/oauth/callback";

export function defaultRedirectUri(origin?: string): string {
  return `${origin ?? "http://localhost:3010"}${OAUTH_CALLBACK_PATH}`;
}

export function buildConsentUrl(args: {
  clientId: string;
  redirectUri: string;
  loginHint?: string;
}): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SEND_SCOPE);
  // offline + consent is what actually returns a refresh token: without
  // access_type=offline Google issues an access token only, and without
  // prompt=consent it withholds the refresh token on every grant after the
  // first — leaving you with nothing to store.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  if (args.loginHint) url.searchParams.set("login_hint", args.loginHint);
  return url.toString();
}

export class GoogleOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleOAuthError";
  }
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

// Trade the one-time ?code= for a refresh token. `tokenEndpoint` is injectable
// so the flow can be exercised against a local stub in tests.
export async function exchangeCodeForRefreshToken(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  tokenEndpoint?: string;
}): Promise<{ refreshToken: string; scope?: string }> {
  const res = await fetch(args.tokenEndpoint ?? TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: args.code,
      client_id: args.clientId,
      client_secret: args.clientSecret,
      redirect_uri: args.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || data.error) {
    throw new GoogleOAuthError(
      data.error_description ?? data.error ?? `Google returned HTTP ${res.status}`
    );
  }
  if (!data.refresh_token) {
    // Google withholds the refresh token when the account has already granted
    // this client and prompt=consent was dropped somewhere along the way.
    throw new GoogleOAuthError(
      "Google returned no refresh token. Revoke this app at " +
        "myaccount.google.com/permissions and connect again."
    );
  }
  return { refreshToken: data.refresh_token, scope: data.scope };
}

// Confirm a stored refresh token still works, without sending mail. Also what
// tells you an External/Testing client has hit its 7-day expiry.
export async function fetchAccessToken(args: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenEndpoint?: string;
}): Promise<{ accessToken: string; expiresIn: number; scope?: string }> {
  const res = await fetch(args.tokenEndpoint ?? TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      refresh_token: args.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || data.error || !data.access_token) {
    throw new GoogleOAuthError(
      data.error_description ?? data.error ?? `Google returned HTTP ${res.status}`
    );
  }
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 3600,
    scope: data.scope,
  };
}

const GMAIL_SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

// Hand a fully-built RFC 822 message to Gmail. Unlike SMTP, this also files a
// copy in the account's Sent folder on its own.
//
// The JSON endpoint caps at 5 MB of base64 payload; invoice PDFs are orders of
// magnitude under that, so the resumable upload endpoint isn't worth the
// round-trips.
export async function gmailSend(args: {
  accessToken: string;
  rawMessage: Buffer;
  endpoint?: string;
}): Promise<{ id: string; threadId?: string }> {
  const res = await fetch(args.endpoint ?? GMAIL_SEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
    },
    // Gmail wants base64url (RFC 4648 §5), not standard base64.
    body: JSON.stringify({ raw: args.rawMessage.toString("base64url") }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    id?: string;
    threadId?: string;
    error?: { message?: string; status?: string };
  };
  if (!res.ok || !data.id) {
    throw new GoogleOAuthError(
      data.error?.message ?? `Gmail API returned HTTP ${res.status}`
    );
  }
  return { id: data.id, threadId: data.threadId };
}
