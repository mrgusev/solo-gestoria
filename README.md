# Solo Gestoría

Single-tenant web tool for managing a Spanish autónomo's bookkeeping:

- Generates monthly invoices in a polished PDF layout
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

**3. Back on the server — build, start, and (optionally) import:**

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
time — a mismatch fails fast.

## License

MIT.
