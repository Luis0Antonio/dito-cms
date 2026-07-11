---
name: setup-dito-cms
description: Set up, run, deploy, or bootstrap Dito CMS — the self-hosted headless CMS in this repository (Cloudflare Worker + D1 + R2 + an MCP server). Use when asked to set this project up, install it, get it running locally, deploy it to Cloudflare, bootstrap an admin/API key without the UI, wire up its MCP server, or make it ready for an AI agent to manage content. Covers three paths — local (test it), deploy (hand config to the user), and fully autonomous (deploy + headless admin + API key + MCP wired in so the agent can model content itself).
---

# Setting up Dito CMS

Dito CMS is a headless CMS that runs entirely in **one Cloudflare Worker**: an
admin SPA, the REST APIs, a public read-only delivery API, media on **R2** (or
**Cloudinary**), structured content on **D1**, Better Auth for auth, and a
stateless **MCP server** at `POST /mcp`. One package, one deploy. This skill gets
it running and — when asked — makes an AI agent a first-class customer of it.

## Pick a path

Choose based on what the user asked for. If it's ambiguous, ask them with
`AskUserQuestion` ("Run it locally to test", "Deploy and I'll configure it",
"Deploy and set it up fully for you"). The three paths:

| Path | What the agent does | When |
|---|---|---|
| **A. Local** | Install deps, migrate a local DB, run the dev server. Optionally create an admin + seed demo content. | "get it running", "let me test it", "run locally" |
| **B. Deploy** | Provision D1 (+ R2, or Cloudinary), deploy to the user's Cloudflare account, then hand off — the user creates the admin in the browser. | "deploy it", "ship it to Cloudflare" |
| **C. Fully autonomous** | Path B **plus** create the admin + an API key headlessly, register the MCP server, and (optionally) start modelling content. | "set it up for me", "deploy and manage content", "make it AI-ready" |

All three share the prerequisites below. Paths B and C also need Cloudflare access.

---

## From zero (you don't have the repo yet)

If the user is starting with nothing, this is the whole sequence — they do steps 1–3 once,
then hand the wheel to Claude Code, which runs the rest of this skill.

1. **Install the basics** (one time): git, [Node ≥ 22](https://nodejs.org),
   a package manager ([Bun](https://bun.sh) recommended, or npm), and
   [Claude Code](https://claude.com/claude-code). For deploying: a free
   [Cloudflare account](https://dash.cloudflare.com/sign-up).
2. **Clone the repo and enter it:**
   ```bash
   git clone https://github.com/Luis0Antonio/dito-cms.git
   cd dito-cms
   ```
3. **Open Claude Code in that folder** (`claude` in the terminal, or open the folder in the
   Claude Code app/IDE extension).
4. **Tell Claude what you want**, e.g.:
   - *"Set up Dito CMS locally so I can try it"* → Path A.
   - *"Deploy Dito CMS to my Cloudflare account"* → Path B.
   - *"Deploy Dito CMS and set it up fully for me with my email <you@co.com>"* → Path C.

   Claude (via this skill) checks prerequisites, runs the steps, and reports back the URL and
   how to log in. The only things it may ask you for: which path, your email (Path C), and —
   only if you're not already logged into Cloudflare — to run `wrangler login`.

> Already cloned, just want it running? Skip to **Path A** (local) or **Path B/C** (deploy).

---

## Prerequisites (all paths)

Run these checks first and fix what's missing before proceeding.

1. **Node ≥ 22** — Wrangler and the Vite build require it.
   ```bash
   node --version    # must be v22+ (or v24)
   ```
   ⚠️ **If it's older** (common when a version manager defaults to an old release),
   activate a newer one. **Node activation does NOT persist between separate shell
   commands in this harness**, so either run each Node/Wrangler step as one compound
   command, or prefix `PATH` every time. Example with nvm:
   ```bash
   export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep -E '^v(22|24)' | sort -V | tail -1)/bin:$PATH"
   node --version
   ```
   (Equivalents: `fnm use 22`, `volta install node@22`. If no manager exists, install Node 22+.)

2. **A package manager** — `bun` is what the README uses (`bun --version`). `npm`/`pnpm`
   also work (`npm install`, `npm run <script>`). Use whatever is present; commands below
   show `bun` — swap in `npm run` if needed.

3. **For Paths B & C only — Cloudflare auth (usually already done).** Most people running
   this are already logged into Wrangler, so just **verify** — don't make them log in again:
   ```bash
   npx wrangler whoami    # prints the account → you're good, continue
   ```
   Only if that says *not* authenticated do you need to act, and `wrangler login` is a
   browser OAuth flow an agent can't complete. In that case, pause and ask the user to run
   `wrangler login` themselves, **or** to provide a scoped API token you can use non-interactively:
   ```bash
   export CLOUDFLARE_API_TOKEN=...      # token with Workers Scripts, D1, R2 edit perms
   export CLOUDFLARE_ACCOUNT_ID=...     # if the token spans multiple accounts
   ```
   Never invent credentials — this is the one thing only the user can supply.

---

## Path A — Local (test it out)

Run these from the repo root. The dev server is long-running, so start it in the
**background** and read the URL it prints.

```bash
bun install
bun run db:migrate:local          # creates the local D1 tables (idempotent)
```
Start the dev server in the background (use the Bash tool's `run_in_background`, or
`nohup ... &`), then poll until it's up:
```bash
bun run dev                       # serves SPA + Worker on http://localhost:5173
```
- ⚠️ **Read the actual URL from the output** — if 5173 is busy it silently uses the next
  port (5174, …). Use that URL for everything below.
- Confirm it's alive: `curl -s <url>/api/health` → `{"ok":true,...}` and
  `curl -s <url>/api/setup/status` → `{"initialized":false}` on a fresh DB.

**That's the minimum** — the user can now open the URL, land on `/setup`, and create the
first admin themselves. To go further and leave them a working, populated instance:

```bash
# Create the first admin + an API key headlessly (no browser):
.claude/skills/setup-dito-cms/scripts/bootstrap-admin.sh <url>

# Seed a demo content model (hero + features + testimonials) using the key it printed:
DITO_API_KEY=<key> DITO_URL=<url> bun run seed
```
Then verify content flows through the public delivery API:
```bash
curl -s <url>/api/v1/content/hero
curl -s <url>/api/v1/content/features
```

**Tell the user**: the URL, the admin email + generated password (from
`.dito-credentials`), and that demo content is live. They sign in at `<url>/login`.

---

## Path B — Deploy to the user's Cloudflare account (then hand off)

After the prerequisites (including Cloudflare auth):

```bash
bun run setup
```
`scripts/setup.ts` is idempotent: it first **prompts for the media storage provider** (R2
default, or Cloudinary), then creates the D1 database (and, for R2, the bucket), writes the
real `database_id` into `wrangler.jsonc`, applies migrations to the remote D1, then **prompts**
"Build and deploy now? [y/N]". Since you're driving it non-interactively, feed both prompts —
a leading empty line keeps the R2 default:
```bash
printf '\ny\n' | bun run setup    # R2 + provision + migrate + build + deploy in one shot
```
For Cloudinary (no R2 bucket needed — setup strips the `r2_buckets` binding and stores
`CLOUDINARY_URL` as a secret after the deploy), answer the provider prompt `2` and paste the
credentials when asked:
```bash
printf '2\ncloudinary://<key>:<secret>@<cloud>\ny\n' | bun run setup
```
If piping into the prompt is unreliable in your shell, do it in two non-interactive steps:
```bash
printf '\nn\n' | bun run setup    # R2: provision + patch wrangler.jsonc + migrate remote
bun run deploy                    # build → migrate remote → wrangler deploy (no prompts)
```

- **Capture the deployed URL** from the `wrangler deploy` output (e.g.
  `https://dito-cms.<subdomain>.workers.dev`). You'll need it.
- The auth secret auto-generates on first boot (stored in D1) — zero config needed. For
  production hardening you may set one explicitly:
  `npx wrangler secret put BETTER_AUTH_SECRET` (generate with `openssl rand -base64 32`).
- **Media storage** is R2 by default. To use **Cloudinary** instead (images + video, no R2
  bucket), set `CLOUDINARY_URL` — either via the setup prompt above, or after a deploy with
  `npx wrangler secret put CLOUDINARY_URL`. Detection is automatic: if the secret is present
  media goes to Cloudinary, otherwise to R2. Verify by uploading an image and checking its URL
  is a `res.cloudinary.com` link (Cloudinary) vs a same-origin `/media/...` path (R2).
- **Store secret encryption** (only if the commerce module is used with payments): payment
  secrets (Culqi secret key) and the order-hook auth header are stored encrypted in D1, keyed by
  `SETTINGS_ENC_KEY` (32 bytes, base64). Set it with `npx wrangler secret put SETTINGS_ENC_KEY`
  (generate with `openssl rand -base64 32`); for local dev add it to `.dev.vars`. Not needed for
  content-only or catalog-only instances — the Worker only uses it when saving/reading those secrets.
- `wrangler.jsonc` now has a real `database_id` (no longer the `000…0` placeholder). That's
  expected for a deployed instance; the user can commit it to their own fork.

**Hand off**: give the user the URL and tell them the first visit goes to `/setup` to create
the admin, after which they manage users and API keys under **Settings**.

Verify the deploy booted: `curl -s <url>/api/health` and `curl -s <url>/api/setup/status`
(expect `initialized:false` until someone completes setup).

---

## Path C — Fully autonomous (deploy + bootstrap + MCP)

This is the flagship path: the agent stands up the CMS **and** becomes its operator.

### First, settle who owns the admin account

Dito's first run creates **exactly one admin** and then closes sign-up — after that, new
users are invite-only (an existing admin adds them under Settings → Users). So whoever creates
the first account owns the instance. **There is no email-based password reset** (the CMS ships
with no mail provider), so the only way back in is the credentials used at creation. That makes
ownership a real decision — settle it before bootstrapping:

- **You own it, agent just hands you the keys (recommended).** The agent creates the admin
  using **your real email** and a password it shows you, so you can log in later. → continue below.
- **You'd rather create the account yourself.** Then you don't need Path C's bootstrap at all —
  use **Path B**: the agent deploys, you open the URL and do `/setup` + create an API key in the
  browser, then paste that key to the agent (or run the `claude mcp add` in Step 3 yourself).
  This is the cleanest ownership story and the right call if you're unsure.

> Ask the user which they want if it isn't obvious. Do **not** silently create an admin under a
> throwaway `@dito.local` email — they'd have no usable way to sign in.

### Step 1 — Deploy
Do Path B and capture the deployed `<url>`.

### Step 2 — Create the admin + API key headlessly
Ask the user for **the email they want to sign in with**, then run (no browser, no UI):
```bash
DITO_ADMIN_EMAIL="you@yourco.com" .claude/skills/setup-dito-cms/scripts/bootstrap-admin.sh <url>
```
- It creates the first admin under that email with a **generated password**, signs in, mints
  an API key, verifies it, writes `./.dito-credentials` (gitignored), and prints exactly **how
  the user logs in later** (URL + email + password + "change it after first login").
- Capture the key from stdout: `KEY=$(DITO_ADMIN_EMAIL="you@yourco.com" .claude/skills/setup-dito-cms/scripts/bootstrap-admin.sh <url> 2>/dev/null)`
- The user wants to choose the password too? Add `DITO_ADMIN_PASSWORD="…"` (≥8 chars; it won't be
  printed or saved). Either way, **surface the login details to the user** — that's the answer to
  "how do I get into the CMS afterward."

### Step 3 — Register the MCP server
So future sessions can manage content with first-class tools:
```bash
claude mcp add --transport http dito <url>/mcp --header "Authorization: Bearer <KEY>"
```
- Add `--scope project` to commit it to this repo's `.mcp.json` (travels with the clone), or
  `--scope user` for the user's machine. Default scope is local to this project dir.
- ⚠️ **MCP tools load at session start.** They won't appear mid-session. For the user, the
  `dito` tools are available next time they start Claude Code here. To act **right now**, see Step 4.

### Step 4 — Model content (optional, "build the structure for a website")
Two ways:
- **Now, in this session:** drive `POST <url>/mcp` directly over HTTP — see the
  [Driving the MCP over HTTP](#driving-the-mcp-over-http) reference below. Call `get_cms_info`
  first, then `create_collection`, `create_entry` (`publish:true`), etc.
- **Later:** once the `dito` MCP is loaded, the tools `mcp__dito__create_collection`,
  `mcp__dito__create_entry`, … are available natively. Always call `get_cms_info` first — it
  returns the field-type reference and delivery URLs for a cold start.

**Tell the user**: the live URL, **how to log in** (email + password the script surfaced — and to
change the password), that the MCP is registered, and how consuming sites read content
(`GET <url>/api/v1/content/<slug>`).

---

## Reference

### What the bootstrap script handles (the non-obvious bits)

`scripts/bootstrap-admin.sh` exists because two Better Auth behaviours make the headless
flow easy to get wrong by hand:
- **`Origin` header required** — state-changing auth calls (`api-key/create`, `sign-in`)
  return `MISSING_OR_NULL_ORIGIN` without an `Origin` header matching the base URL.
- **HttpOnly session cookie** — sign-in sets `better-auth.session_token` as HttpOnly; you
  must persist it in a curl cookie jar and replay it on `api-key/create`.

The endpoints, if you ever need them directly:
`POST /api/auth/sign-up/email` `{name,email,password}` → first admin (only while the user
table is empty); `POST /api/auth/sign-in/email` `{email,password}` → session cookie;
`POST /api/auth/api-key/create` `{name}` (cookie + Origin) → `{ "key": "dito_…" }`.

### Driving the MCP over HTTP

The MCP server is stateless JSON-RPC. Send `Accept: application/json, text/event-stream`
and a Bearer key. No session handshake is required (you can call `tools/list`/`tools/call`
directly). Example — list tools, then create + publish a singleton:
```bash
MCP() { curl -s -X POST "$URL/mcp" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -H 'Accept: application/json, text/event-stream' -d "$1"; }

MCP '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_cms_info","arguments":{}}}'
MCP '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_collection","arguments":{"slug":"hero","name":"Hero","type":"singleton","fields":[{"name":"headline","label":"Headline","type":"text","options":{"required":true}}]}}}'
MCP '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_entry","arguments":{"collection":"hero","publish":true,"data":{"headline":"Hello"}}}}'
```
The 16 tools: `get_cms_info`, `list_collections`, `get_collection`, `create_collection`,
`update_collection`, `set_collection_fields`, `delete_collection`, `list_entries`,
`get_entry`, `create_entry`, `update_entry`, `publish_entry`, `unpublish_entry`,
`delete_entry`, `list_media`, `upload_media_from_url`. Field types: text, rich_text, number,
boolean, picture, video, link (see `get_cms_info` for per-type options).

### Verification checklist

- Local/Deploy boots: `GET /api/health` → `{"ok":true}`.
- Fresh vs initialized: `GET /api/setup/status` → `{"initialized":bool}`.
- Key works: `GET /api/admin/me` with `Authorization: Bearer <key>` → `{"via":"apikey"}`.
- MCP up: `POST /mcp` `tools/list` returns 16 tools; the same call **without** a key → 401.
- Content flows: publish an entry, then `GET /api/v1/content/<slug>` returns it (delivery
  serves published content only).

### Gotchas

- **Free-tier CPU + password hashing.** Better Auth uses scrypt; sign-up/sign-in can approach
  the free plan's 10 ms CPU limit on a deployed Worker. If `bootstrap-admin.sh` gets a 500 on
  a deployed free-tier instance, that's the cause — **Workers Paid is recommended** for
  production. (Locally there's no CPU limit, so it always works there.)
- **API keys are not rate-limited** by design (trusted, high-volume callers). Treat them as
  secrets; `.dito-credentials` is gitignored. Revoking a key immediately 401s it.
- **Open sign-up closes after the first admin.** A second `sign-up/email` returns 403 — that's
  why the script signs in (not signs up) on an already-initialized instance.
- **`.dito-credentials`** holds the admin password (first run) and API key. Never commit it;
  it's already in `.gitignore`.
