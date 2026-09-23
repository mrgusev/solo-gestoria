# Solo Gestoría

Single-tenant web tool for managing a Spanish autónomo's bookkeeping:

- Manages any number of clients, each with its own VAT treatment
- Issues multi-line invoices — Spanish clients with IVA + IRPF retención,
  EU businesses under the reverse charge — in a polished PDF layout
  (`FACTURA` in Spanish, `INVOICE` in English)
- Bills clients on a schedule (monthly / quarterly / yearly) and emails the
  invoice PDF to them over SMTP, after a tap-to-confirm on Telegram
- Ingests expense PDFs with OpenAI, computes deductible amounts
- Auto-tracks monthly RETA (social-security) cuotas
- Produces per-quarter dashboards with MOD 130 / 303 / 349 box values
- Generates AEAT-compatible `fichero de importación` (`.130` / `.303` / `.349`)
  files for upload via Sede Electrónica's _Importar_ button
- Optional Telegram bot (long-polling worker) for chat-based bookkeeping
  with voice transcription and tap-to-confirm mutations

## Stack

Next.js 16 (App Router) + TypeScript + Prisma 7 + SQLite (better-sqlite3 adapter)
+ Tailwind 4 + `@react-pdf/renderer` + OpenAI SDK.

## Local development

```bash
cp .env.example .env             # then edit APP_PASSWORD, SESSION_SECRET, OPENAI_API_KEY
cp prisma/seed.config.example.json prisma/seed.config.json
# edit prisma/seed.config.json with your issuer details + default client
npm install
npm run db:push                  # create SQLite at ./data/dev.db
npm run db:seed                  # populate Settings + default Client from your seed.config.json
npm run dev                      # http://localhost:3010
```

`prisma/seed.config.json` is gitignored — your personal issuer/client info
lives there. The seed is an idempotent upsert: re-running it leaves
existing rows alone, only filling in what's missing.

Useful scripts:

- `npm run db:reset` — wipe DB and reseed (destructive)
- Anything under `prisma/local/` — your private scratch scripts (gitignored)

## Server deployment

The whole stack runs in Docker. The server only needs Docker and Docker
Compose installed — no Node, no npm.

### Compose services

| Service | What it runs | When |
|---|---|---|
| `app` | Next.js web UI on port 3010 | always |
| `bot` | Telegram bot worker (long-polling) | always (idle/crash-loops if no token in Settings — that's fine) |
| `migrate` | One-shot historical import from PDFs | only when invoked with `--profile migrate` |

Volumes mounted by `docker-compose.yml`:

- `./data` → `/data` (SQLite DB — the entire authoritative state)
- `./uploads` → `/uploads` (original receipt PDFs + persisted invoice PDFs)
- `./dataexport` → `/dataexport:ro` (only mounted on the `migrate` service)
- `./prisma/seed.config.json` → `/app/prisma/seed.config.json:ro` (`migrate` only)

### Clean install on a fresh server

Prereqs: a VPS with Docker + Docker Compose installed, SSH access, ~1 GB
free disk.

**1. On the server — clone and configure secrets:**

```bash
git clone https://github.com/YOU/solo-gestoria.git
cd solo-gestoria

cp .env.example .env
# edit .env, set:
#   APP_PASSWORD       your login password
#   SESSION_SECRET     long random — `openssl rand -hex 32`
#   OPENAI_API_KEY     a fresh key from platform.openai.com
nano .env
```

**2. From your laptop — push your personal config (and dataexport if you have one):**

```bash
# Always: your issuer + client details.
rsync -avz ./prisma/seed.config.json user@server:~/solo-gestoria/prisma/

# Optional: historical invoice + expense PDFs to import.
# Skip this if you don't have a Xolo / prior-gestoría export.
rsync -avz ./dataexport user@server:~/solo-gestoria/
```

If you don't have a `prisma/seed.config.json` locally yet, create one on
the server: `cp prisma/seed.config.example.json prisma/seed.config.json`
and edit it.

**3. Back on the server — fix permissions on the bind-mounted dirs:**

The container runs as uid `1001`. Pre-create the persistent dirs with that
ownership, and make `dataexport/` readable (macOS rsync preserves mode 700,
which the container can't see into):

```bash
mkdir -p data uploads
sudo chown -R 1001:1001 data uploads
[ -d dataexport ] && sudo chmod -R o+rX dataexport
```

**4. Build, start, and (optionally) import:**

```bash
# Build images + start app + bot
docker compose up -d --build

# Only if you uploaded dataexport/: import history
docker compose --profile migrate run --rm migrate
```

App is now live at `http://server:3010`. Log in with `APP_PASSWORD`.

### How the historical import works

The `migrate` service:

- Upserts `Settings` + `Client` from `prisma/seed.config.json`.
- Reads each PDF in `dataexport/INVOICE/`, extracts date/dueDate/hours/rate/totals
  with OpenAI structured extraction, creates the `Invoice` row, and copies
  the original PDF byte-for-byte into `uploads/invoices/<id>.pdf` so
  downloads serve the original.
- Reads each PDF in `dataexport/EXPENSE/`, extracts vendor/date/amounts/category,
  creates a `CONFIRMED` `Expense` row, copies the PDF to
  `uploads/expenses/<uuid>.pdf`.
- Re-runs `ensureRetaExpensesForYear` for every year with an invoice.

Expected `dataexport/` shape:

```
dataexport/
├── INVOICE/      *.pdf  (FACT-YYYY-NNNNN in the filename is preferred)
└── EXPENSE/      *.pdf  (vendor-named, format doesn't matter)
```

Idempotent for invoices (skips numbers already in the DB). Expenses are
append-only — wipe `data/dev.db` if you want to re-run from scratch.

Cost: one OpenAI structured-extraction call per PDF (~$0.001 each). 100
PDFs ≈ $0.10.

### Configuring the Telegram bot

The `bot` service starts automatically but will crash-loop until you've
set the token. To enable it:

1. Open `http://server:3010/settings`, paste your @BotFather token + a
   comma-separated list of allowed Telegram chat IDs, save.
2. `docker compose restart bot` — picks up the new token from the DB.
3. `docker compose logs -f bot` — verify it logged in.

The agent's system prompt is built at runtime from your `Settings` row +
the optional `"agent"` block in `prisma/seed.config.json`. Set the
`userDescription` and `businessNotes` strings there to give the model
grounded context about your régimen, billing situation, etc.

### Day-to-day commands

```bash
docker compose logs -f app                       # tail web server logs
docker compose logs -f bot                       # tail bot logs
docker compose restart app                       # restart web only
docker compose ps                                # show service status

# Update to a newer commit:
git pull && docker compose up -d --build

# Stop everything (data persists in ./data + ./uploads):
docker compose down
```

### Backups

The entire authoritative state is two host directories and one config
file. To back up:

```bash
tar czf ~/solo-gestoria-backup-$(date +%F).tgz \
  data/ uploads/ .env prisma/seed.config.json
```

Restore = untar into a clean clone and `docker compose up -d --build`.

### HTTPS / reverse proxy

`docker-compose.yml` exposes the app on plain HTTP at port 3010. For any
internet-facing deployment, terminate TLS in front of it with one of:

- **Caddy** at the host level (`caddy reverse-proxy --from your-domain --to :3010`),
- **nginx** with Let's Encrypt,
- or **Cloudflare Tunnel** if the server isn't directly reachable.

Without HTTPS, the session cookie is sent in cleartext on every request
and `Secure` is dropped — fine for a LAN install, not for public deployment.

### Migrating an already-running local install

If you've been running locally and want to lift the whole working state
onto a server (no re-parsing needed), rsync the persistent state and
the entrypoint picks it up automatically:

```bash
rsync -avz --delete \
  ./data ./uploads ./.env ./prisma/seed.config.json \
  user@server:~/solo-gestoria/

ssh user@server "cd ~/solo-gestoria && docker compose up -d --build"
```

| Path | Holds |
|---|---|
| `data/dev.db` | all invoices, expenses, clients, settings, reminders, agent state |
| `uploads/expenses/` | original uploaded receipt PDFs (one per expense, by UUID) |
| `uploads/invoices/` | persisted invoice PDFs (one per invoice, by id) |
| `.env` | secrets (APP_PASSWORD, SESSION_SECRET, OPENAI_API_KEY) |
| `prisma/seed.config.json` | issuer + default client + agent context |

## Telegram bot worker

The bot polls Telegram, accepts text + voice messages + uploaded receipt
PDFs, and runs an OpenAI-backed agent with tools. Mutations (update /
delete expenses or invoices) are gated behind explicit tap-to-confirm
buttons in the chat.

It runs automatically as the `bot` compose service. To configure:

1. Open `/settings` in the web UI.
2. Paste your @BotFather token and a comma-separated list of allowed chat IDs.
3. The worker picks up the new token on its next restart — run
   `docker compose restart bot`.

For local development without Docker: `npm run bot`.

The agent's system prompt is built at runtime from your `Settings` row +
the optional `"agent"` block in `prisma/seed.config.json`. Set the
`userDescription` and `businessNotes` strings there to give the model
grounded context about your régimen, billing situation, etc.

## Clients and tax treatment

Clients live at `/clients`. Each one carries a **VAT treatment** that every
invoice snapshots at issue time, so editing a client never rewrites invoices
you have already filed:

| Treatment | Invoice | Where it lands |
|---|---|---|
| `DOMESTIC_ES` — Spanish client | IVA repercutido (21% default) and IRPF retención withheld (15% default) | MOD 303 boxes [07]/[08]/[09] → [27]; retención in MOD 130 box [06] |
| `INTRA_EU_REVERSE_CHARGE` — EU business | Exempt, art. 25 Ley 37/1992 | MOD 303 box [59] + one MOD 349 row |
| `EXPORT_NON_EU` — non-EU business | Not subject to Spanish VAT (place-of-supply rules) | Neither [59] nor MOD 349 |

Picking a country in the client form pre-fills the treatment, rates and invoice
language; every field stays editable. The 15% retención drops to **7% during
the first three years of activity** — set that per client. Rates are stored as
fractions (`0.21`, `0.15`); the forms show percentages.

The global defaults under Settings (`defaultVatRate`, `defaultIrpfRetentionRate`)
only seed the client form — the **Client row is what invoices actually read**.

Two consequences worth knowing:

- **Income is the base imponible.** The dashboard, MOD 130 box [01] and MOD 303
  all use the net base, never the invoice total (which includes IVA and is net
  of the retención).
- **MOD 130 may stop being required.** Once ≥70% of the year's income has
  carried IRPF retención you are exempt from filing it at all (art. 109.2
  RIRPF). The quarter report shows the running percentage; it does not act on
  it for you.

Invoices are multi-line: add rows with their own quantity, unit, price and IVA
rate at `/invoices/new`. The Telegram bot can add clients (`create_client`) and
issue the single-line hours × rate invoice for any of them, inheriting that
client's IVA and IRPF; **multi-line invoices and editing or deleting a client
are web-UI-only**.

## Bank accounts

`/settings/bank-accounts` holds the payment destinations an invoice can print.
Which one a new invoice gets is decided in this order:

1. the account picked explicitly in the invoice editor ("Paid into"),
2. the account whose rule claims the client's tax treatment — e.g. one account
   marked *Spanish clients* takes every `DOMESTIC_ES` factura,
3. the account marked **fallback**, which every other invoice uses.

The choice is resolved once, when the invoice is issued, and stored on the
`Invoice` row. Re-pointing a rule later never rewrites the payment details of
an invoice already sent — editing the account's own fields does, so archive
rather than repurpose an account that historical invoices reference. An account
with invoices behind it can't be deleted, only archived (which hides it from
the pickers and drops its rules).

One account also carries the **AEAT** flag: its IBAN is what goes into the
MOD 303 / MOD 130 fichero for a refund or domiciliación.

An install upgrading from the single-account version keeps working untouched:
the seed turns the old `Settings.bank*` fields into the first account and points
existing invoices at it. Extra accounts can be pre-provisioned from
`prisma/seed.config.json` via a `bankAccounts` array (see
`seed.config.example.json`) — entries are created by stable `id` and never
overwritten afterwards.

## Recurring invoices

A schedule at `/recurring` is a standing instruction: a client, a cadence, and
the lines to bill each time. The bot worker checks hourly and, when an
occurrence comes due, DMs you a **preview PDF** with _Issue & send_ / _Skip_.

Nothing is issued until you tap. That ordering is deliberate — an invoice
number is permanent, and the `FACT-YYYY-NNNNN` series has to stay gapless
(art. 6.1.a RD 1619/2012), so a "maybe" invoice that later gets deleted would
leave a hole an inspector can see. Skipping a period costs nothing; the next
occurrence takes the next number.

- **Cadence**: monthly, quarterly or yearly, on a chosen day of the month. Day
  31 falls back to the last day of short months.
- **Idempotency**: one run row per (schedule, period), so a worker restart or a
  second tick can't bill the same month twice.
- **Catch-up**: after downtime the cron still posts occurrences it missed,
  going back at most 45 days.
- **Send now**: the button on `/recurring` issues and emails this period
  immediately, bypassing the Telegram round-trip.
- Editing a schedule only affects future occurrences; invoices already issued
  keep what they were created with.

### Email (SMTP)

Configure the mail server under Settings → **Email (SMTP)**; "Test connection"
authenticates without sending anything. Any invoice can also be mailed on
demand from its detail page, and `Invoice.emailedAt` records what went out.

With a Gmail account, host is `smtp.gmail.com` and port `587` (or `465` with
implicit TLS). Two ways to authenticate:

**Sign in with Google (OAuth2)** — recommended on a Workspace domain. In
[Cloud Console](https://console.cloud.google.com/apis/credentials) create an
OAuth client of type **Web application**, set the app's audience to
**Internal**, enable the **Gmail API**, and add the redirect URI shown in
Settings to the client's _Authorized redirect URIs_. Paste the client ID and
secret into Settings, hit **Connect Google account**, consent, and the refresh
token is stored for you.

- **The only scope requested is `gmail.send`** — send-only. The app cannot
  read, search, label or delete anything in the mailbox, so a leaked refresh
  token can't be used to go through your mail.
- That scope is invalid for SMTP: Gmail's SMTP endpoint only accepts the
  full-mailbox `https://mail.google.com/`. So OAuth mode sends through the
  **Gmail API** (`users.messages.send`) and ignores the host/port fields
  entirely. It also files its own copy in _Sent_, which SMTP does not.
- Internal (Workspace) clients need no app verification, and their refresh
  tokens don't expire.
- An **External** client left in "Testing" expires refresh tokens after
  **7 days** — it will look fine, then break the cron a week later.
- Google only accepts `https://` redirect URIs, plus `http://localhost` and
  `http://127.0.0.1`. On a plain-HTTP LAN address, register the localhost URI
  and use the paste-the-code fallback under Settings.
- **Test connection** redeems the refresh token and checks the granted scope,
  so a revoked or expired grant shows up there rather than mid-cron.

**App Password** — simpler, needs 2-Step Verification on; generate one at
[myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
Google labels these "not recommended" but has not removed them. Workspace
admins can disable them by policy, in which case use OAuth2.

Either way the From address must be the authenticated account or an alias
verified under Gmail's _Send mail as_, otherwise Google rewrites the header.

Mail sent over SMTP doesn't land in Gmail's Sent folder, so **Bcc myself** is
on by default to keep an audit copy.

## Filing quarterly forms

1. Open `/reports/<year>/<quarter>` — review each form's box values.
2. Click "Download MOD 130/303/349 XML" to grab the `fichero de importación`.
3. Log into [Sede Electrónica](https://sede.agenciatributaria.gob.es) with
   your digital certificate or Cl@ve PIN.
4. Open the form's "Presentar declaración" page and use the _Importar_
   feature to upload the downloaded file.
5. Review, sign, present.

Deadlines (1T/2T/3T): 20th of the month following the quarter. 4T forms
have varied deadlines (30 Jan / 30 Jan / 20 Jan for 303 / 130 / 349). The
report page reminds you per form.

## AEAT spec references

The generators in `src/lib/aeat.ts` follow the official record designs:

- MOD 303: `docs/aeat/DR303e26v101.xlsx` (Orden HFP/2024 → ejercicio 2026+)
- MOD 130: `docs/aeat/DR130e15v12.xls` (Orden HAP/258/2015, currently in force)
- MOD 349: `docs/aeat/DR_Anexo_349.pdf` (Orden HAC/174/2020, ejercicio 2020+)

When AEAT publishes a new version, update the spec file and revisit
`buildMod*` in `src/lib/aeat.ts`. The lengths are asserted at generation
time — a mismatch fails fast. Only the 4%, 10% and 21% IVA rates have boxes on
MOD 303; an invoice at any other rate makes generation throw rather than
silently drop the base from the declaration.

## License

MIT.
