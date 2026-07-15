# Dito CMS

A simple, open-source **headless CMS for corporate landing pages**, self-hosted on your
own Cloudflare account. You define your content model in a builder UI, author content with
a draft → publish workflow, and consuming sites read published content from a public,
read-only delivery API. A built-in **MCP server** lets Claude — or any AI agent — set up
the model and manage content for you.

Everything runs in **one Cloudflare Worker**: the admin SPA, the APIs, media on R2, and
structured content on D1. One package, one deploy.

> **Status:** feature-complete (v1). Auth + first-run setup, the schema builder, entries
> with draft/publish, the public delivery API, the R2 media pipeline, and the MCP server
> are all in.

## What you get

- **Self-hosted on your Cloudflare account** — content lives in your own D1 + R2. No
  third-party SaaS, no per-seat pricing.
- **Visual content modeling** — define **collections** (many entries) and **singletons**
  (exactly one) with nine field types (including entry-to-entry **references** and preset
  **select** dropdowns) in a drag-and-drop schema builder.
- **Draft → publish** — edits are saved as drafts; the delivery API only ever serves the
  last published version.
- **Public delivery API** — read-only, CORS-open, ETag-cached JSON at `/api/v1/*`, ready
  for any frontend.
- **AI-native** — a built-in MCP server lets an agent model content, author entries, and
  pull in media from a URL.
- **One Worker** — admin UI, APIs, and media all build and deploy together.

## Use it with AI

This repo ships a Claude Code skill,
[`setup-dito-cms`](.claude/skills/setup-dito-cms/SKILL.md), that walks an agent through the
whole thing — run it locally to test, deploy it to Cloudflare, or go fully autonomous
(deploy + create the admin and an API key + wire up the MCP server so the agent can model
content itself). From scratch:

```bash
git clone https://github.com/Luis0Antonio/dito-cms.git
cd dito-cms
claude                       # then say: "set up Dito CMS"
```

Claude handles the prerequisites and the steps; it only asks you which path, your email
(for the fully-autonomous admin), and — if you're not already logged in — to run
`wrangler login`.

Once an instance is running, point any MCP client at it to manage content directly — see
[MCP server](#mcp-server) below.

## Tech stack

| Concern | Choice |
|---|---|
| Build / host | Vite 8 + `@cloudflare/vite-plugin`, Wrangler 4 |
| Worker | Hono 4 |
| Database | Cloudflare D1 + Drizzle ORM (SQLite) |
| Storage | Cloudflare R2 (or Cloudinary) |
| Auth | Better Auth (email + password, `admin` + `apiKey` plugins) |
| SPA | React 19, TanStack Router + Query, shadcn/ui, Tailwind v4 |
| Validation | Zod 4 (shared isomorphic module) |
| Rich text | TipTap 3 (editor) + a DOM-free server serializer |
| MCP | `@modelcontextprotocol/sdk` + `@hono/mcp` (stateless streamable HTTP) |
| i18n | Built-in Spanish/English, Spanish default |

## Local development

```bash
bun install
bun run db:migrate:local   # create local D1 tables
bun run dev                # SPA + Worker together in workerd, with real local D1/R2
```

Open the printed URL (e.g. http://localhost:5173). On first run you'll land on **/setup**
to create the initial admin account. After that, open sign-up is disabled and new users
are added invite-only from **Settings → Users**.

Useful scripts:

```bash
bun run typecheck   # tsc across app / worker / node configs
bun run lint        # eslint
bun run build       # production build (client + worker bundles)
bun run db:generate # regenerate migrations from the Drizzle schema
bun run db:auth     # regenerate the Better Auth schema (after bumping the dep)
bun run seed        # seed a demo landing-page model (needs DITO_API_KEY — see below)
```

## Deploy to your Cloudflare account

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Luis0Antonio/dito-cms)

Or with the CLI (`wrangler login` first):

```bash
bun run setup   # creates D1 + R2, writes their ids into wrangler.jsonc, migrates, deploys
```

Or fully manually:

```bash
wrangler d1 create dito-cms-db        # copy the database_id into wrangler.jsonc
wrangler r2 bucket create dito-cms-media
bun run deploy                        # build → migrate remote D1 → wrangler deploy
```

The first visit to your `*.workers.dev` URL is the **/setup** first-run screen.

> The Deploy-to-Cloudflare button provisions D1 + R2 and rewrites their ids, but does **not**
> run migrations. `bun run deploy` applies them first (`wrangler d1 migrations apply DB --remote`),
> and the Worker auto-generates an auth secret if none is set — so a button deploy still boots.

### Auth secret

Optional. If `BETTER_AUTH_SECRET` is unset, the Worker auto-generates one and stores it in
the D1 `settings` table — so zero configuration is needed. For production, set it
explicitly: `wrangler secret put BETTER_AUTH_SECRET` (see `.dev.vars.example`). A set value
always wins over the stored fallback.

### Media storage (R2 or Cloudinary)

Media can live on **Cloudflare R2** (the default) or **Cloudinary** — chosen at deploy time by
**which credentials you set**, nothing else:

- **R2 (default):** no extra config. Objects are served from your own origin at
  `/media/:id/:filename` with an immutable cache and Range support.
- **Cloudinary:** set `CLOUDINARY_URL` (the `cloudinary://<api_key>:<api_secret>@<cloud_name>`
  value from the Cloudinary Console). All media — images **and** video — then uploads to
  Cloudinary and is served from its CDN; **no R2 bucket is required**. For a deployed Worker:
  `wrangler secret put CLOUDINARY_URL`; for local dev, add it to `.dev.vars`.

You only ever configure one — the other never blocks deployment. `bun run setup` prompts for the
provider and, when you pick Cloudinary, stores the secret and removes the `r2_buckets` binding
from `wrangler.jsonc` so the deploy needs no bucket. Switching providers does not migrate
existing files; each object keeps serving from the backend it was uploaded to. Cloudinary upload
size is governed by your Cloudinary plan (lower `MAX_CLOUDINARY_VIDEO_BYTES` in
`src/shared/constants.ts` to cap video below the 2 GB default).

Running a **fleet** of clients? The provider is chosen **per client** at provision time —
`bun run new-client acme --cloudinary` puts that one client on Cloudinary while others stay on R2,
all from the same shared build. See [Managing multiple clients](#managing-multiple-clients).

### Store secret encryption (commerce module)

Optional, and only relevant when the commerce module is enabled and you configure payments.
Payment-provider secrets (the Culqi secret key) and the order-hook auth header are stored
**encrypted** (AES-256-GCM) in the D1 `settings` table, keyed by `SETTINGS_ENC_KEY` — a 32-byte
key, standard-base64-encoded. Generate one with `openssl rand -base64 32`. For a deployed Worker:
`wrangler secret put SETTINGS_ENC_KEY`; for local dev, add it to `.dev.vars`. It is required only
when saving or using those secrets — content-only and catalog-only instances never need it, and
the Worker never touches the key at boot.

## Managing multiple clients

| Command | Use it to | Creates infra? |
|---|---|---|
| `bun run new-client <name>` | Provision **and** deploy a **new** client | ✅ D1 (+ R2 unless `--cloudinary`) |
| `bun run deploy-client <name>` | Redeploy **one existing** client | ❌ must exist |
| `bun run deploy-all` | Redeploy **every** client (one shared build) | ❌ must exist |
| `bun run studio-client <name>` | Open Drizzle Studio on **one client's remote D1** | ❌ reads/writes live data |

All accept `--account <id>` for multi-account logins (see the callout below). Add `--cloudinary`
to `new-client` to put a client's media on Cloudinary instead of R2 (see [Per-client media storage](#per-client-media-storage)).

Running Dito for several clients? You do **not** need a clone — or a GitHub repo — per client.
Each Dito instance is single-tenant (one Worker + one D1 + one R2), and that isolation is the
point: separate data, separate billing, and offboarding a client is just deleting its Worker.
From this one clone you provision and deploy an isolated instance per client with one command:

```bash
bun run new-client acme               # creates D1 + R2, writes clients/acme.jsonc, migrates, deploys dito-acme
bun run new-client beta --cloudinary  # same, but media on Cloudinary — no R2 bucket for this client
```

> **Multiple Cloudflare accounts?** If `wrangler whoami` lists more than one account, wrangler
> can't pick in non-interactive mode — target one per run with `--account <id>` (or the
> `CLOUDFLARE_ACCOUNT_ID` env var); every fleet command honors it:
>
> ```bash
> bun run new-client acme --account <id>
> bun run deploy-all --account <id>
> ```
>
> With a single account it's optional. (`wrangler login` first if you're not authenticated.)

For client `acme` this provisions D1 `dito-acme-db` and R2 `dito-acme-media`, writes
`clients/acme.jsonc` (that client's config), applies migrations, builds, and deploys the Worker
`dito-acme` — printing its `https://dito-acme.<your-subdomain>.workers.dev` URL. The first visit
is the usual **/setup** first-run screen. Re-running is idempotent: it reuses the existing
resources and just refreshes the config and redeploys.

Redeploy after a code or schema change:

```bash
bun run deploy-client acme   # migrate + build + redeploy one client
bun run deploy-all           # build once, then migrate + redeploy EVERY client in clients/
```

`deploy-all` is how you roll a CMS update out to the whole fleet — all clients share the same
code and a single build.

**`clients/<name>.jsonc` is your fleet's source of truth.** Each is a copy of `wrangler.jsonc`
with the Worker `name` and D1/R2 resource ids swapped (binding names stay `DB` / `MEDIA`, so no
app code changes). They hold no secrets — only Cloudflare resource ids — and are **gitignored**
(the `clients/` directory is kept out of the repo): they live in your working clone and, because a
`database_id` is inert without account auth, can be regenerated from the account (`wrangler d1 list`)
if lost. **GitHub is not required to deploy:** `wrangler deploy` ships straight from this clone; only
the "Deploy to Cloudflare" button needs a Git connection.

Per-client knobs are the same as a single instance: the [auth secret](#auth-secret)
auto-generates (or set `BETTER_AUTH_SECRET` per client), [Workers Paid](#plan-limits--notes) is
recommended for production, and you set any per-client secret with
`wrangler secret put <NAME> -c clients/<name>.jsonc`.

### Inspecting a client's database

Open [Drizzle Studio](https://orm.drizzle.team/drizzle-studio/overview) against **one client's
live remote D1** — the exact rows that client's Worker serves. The D1 id is read from
`clients/<name>.jsonc`:

```bash
bun run studio-client acme
```

Studio reaches D1 over Cloudflare's HTTP API, which needs two credentials `wrangler login` can't
provide:

- **`CLOUDFLARE_ACCOUNT_ID`** — pass `--account <id>`, or set the env var (also read from a
  gitignored `.env`).
- **`CLOUDFLARE_D1_TOKEN`** — a Cloudflare API token with **D1 : Edit**, created at
  [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
  (Custom token → Account · D1 · Edit). Put it in your shell env or `.env`. Set both once and it's
  a single command per client (`CLOUDFLARE_API_TOKEN` is accepted as a fallback).

> ⚠ **This is live production data** — Studio edits write straight through, with no local copy and
> no undo. For the local dev database use `bun run db:studio` instead.

No API token to hand? Snapshot the client's D1 to a local SQL dump with your existing `wrangler`
login (read-only, no token) and inspect it with any SQLite tool:

```bash
npx wrangler d1 export dito-acme-db --remote --output acme.sql
```

### Per-client media storage

Each client picks its own [media backend](#media-storage-r2-or-cloudinary) at provision time — one
client can run on Cloudinary while the rest stay on R2, all served by the **same shared build**:

```bash
bun run new-client acme               # R2 (default): provisions dito-acme-media
bun run new-client beta --cloudinary  # Cloudinary: no R2 bucket; media goes to Cloudinary
```

- **No flag → R2**, exactly as before. `--cloudinary` provisions D1 but **no** R2 bucket, and
  deploys a Worker with no `MEDIA` binding — its media identity is the `CLOUDINARY_URL` secret.
- **Credentials never touch the command line.** `new-client --cloudinary` reads the URL from the
  `$CLOUDINARY_URL` env var (ideal for CI) or a muted interactive prompt, **validates it up front**
  (before any infra is created), and stores it with `wrangler secret put CLOUDINARY_URL -c clients/<name>.jsonc`
  **after** the first successful deploy (secrets attach to a live Worker). If that final step fails,
  the command prints the exact manual `wrangler secret put …` to run.
- **The client's config records the choice.** A Cloudinary client's `clients/<name>.jsonc` simply
  omits the `r2_buckets` block; that presence/absence is what `deploy-client`/`deploy-all` read to
  redeploy each client on the right backend — no flag needed on redeploy. `deploy-*` print
  `storage: r2` / `storage: cloudinary` per client so a missing secret is easy to spot.
- **Existing clients are unaffected.** R2 clients keep their `r2_buckets` block and redeploy exactly
  as before; the base `wrangler.jsonc` stays pristine R2. Switching an existing client's provider is
  **not** supported in v1 — new clients only. (Switching wouldn't migrate already-uploaded files
  anyway; each object keeps serving from the backend it was uploaded to.)

### Custom domains

Each client eventually wants `cms.theirdomain.com`. Add it per client — either from the
Cloudflare dashboard (the Worker's **Settings → Domains & Routes**) or by adding a `routes`
entry to `clients/<name>.jsonc`:

```jsonc
"routes": [{ "pattern": "cms.theirdomain.com", "custom_domain": true }]
```

The domain's zone must be on the same Cloudflare account. (Left out of `new-client` for now —
it's a one-time add per client.)

### Offboarding a client

```bash
wrangler delete --name dito-acme        # delete the Worker
wrangler d1 delete dito-acme-db         # delete the database
wrangler r2 bucket delete dito-acme-media   # delete the bucket
rm clients/acme.jsonc                   # drop the config
```

## Content model & authoring

Define **collections** (many entries) and **singletons** (exactly one entry) in the schema
builder. Each has **fields** of nine types: text, rich text, number, boolean, picture,
video, link, **reference** and **select**. A `reference` field links entries to other entries
(item → category, post → author, page → related pages): you pick the target entry rather than
typing a name, and it stores a stable id. A `select` field offers a preset list of text options
rendered as a dropdown, so editors choose one value instead of typing free text. Authoring is
**draft → publish**: edits are saved as
drafts, and the delivery API only ever serves the last published version. Required fields and
bounds are enforced at publish time, not while drafting.

Seed a demo model (hero + features + testimonials) to see it end to end:

```bash
DITO_API_KEY=dito_xxx bun run seed
# against a deployed instance:
DITO_API_KEY=dito_xxx DITO_URL=https://your-worker.workers.dev bun run seed
```

Create the key under **Settings → API keys**.

## Reading content (delivery API)

The delivery API at `/api/v1/*` is **public, read-only, CORS-open**, and serves only
published content. Media references are expanded to absolute URLs derived from the request
origin, so the same response works on any domain.

```
GET /api/v1/collections                         # public schema (collections + fields)
GET /api/v1/content/:slug                       # collection list, or the singleton object
GET /api/v1/content/:slug?limit&offset&sort&filter[field][op]=value
GET /api/v1/content/:slug/:idOrSlug             # one published entry by id or slug
```

Filter ops: `eq, ne, lt, lte, gt, gte, contains`. Responses carry `ETag` +
`Cache-Control`; send `If-None-Match` for a `304`.

**Reference fields** are **expanded** in delivery responses. A stored target id becomes an
object (an array of them when the field is `multiple`), and a deleted or unpublished target
becomes `null`:

```jsonc
"category": { "id": "V1St…", "slug": "fruit", "title": "Fruit", "collection": "categories" }
```

`title` comes from the target's published title field. Expansion is one level deep in v1 (no
nested target `data`). Filter by a reference with the **target's id**:

```
GET /api/v1/content/items?filter[category][eq]=<fruitId>     # single reference
GET /api/v1/content/posts?filter[tags][eq]=<tagId>           # multiple reference: contains
```

Renaming a referenced entry busts the referrer's `ETag`, so a `304` never serves a stale
expanded title.

### Localized content

When a deployment configures more than one content language (Settings → **Content languages**),
fields marked **Localized** in the schema store a per-language value. Pick the language at
delivery with `?locale=`:

```
GET /api/v1/content/:slug?locale=en                 # English values
GET /api/v1/content/:slug?filter[title][contains]=…&locale=en   # filter/sort on the English value
GET /api/v1/collections                             # payload also carries { locales, defaultLocale }
```

- **Fallback:** a locale with no translation for a field falls back to the **default** locale
  (then the field default). Filtering and sorting resolve the same way, so they operate on
  exactly the value the response returns.
- **Unknown or absent `locale`** → the default locale. Valid values are advertised as `locales`
  in `GET /api/v1/collections`.
- **Locale comes from the URL only** (never `Accept-Language`): `?locale=es` and `?locale=en`
  are distinct, independently-cacheable URLs, and the `ETag` folds in the locale, so a `304`
  never serves one language's bytes for another.
- Non-localized fields (including all `picture`/`video`/`reference` fields) are **shared** across
  languages and unaffected. A single-language deployment behaves exactly as before.

### Consuming from Astro

```astro
---
const base = "https://your-worker.workers.dev/api/v1";

// Singleton → { data: { id, slug, publishedAt, data } }
const { data: hero } = await fetch(`${base}/content/hero`).then((r) => r.json());

// Collection → { data: [ { id, slug, data }, … ], meta: { total, limit, offset } }
const { data: features } = await fetch(`${base}/content/features`).then((r) => r.json());
---
<section>
  <h1>{hero.data.headline}</h1>
  <p>{hero.data.subheadline}</p>
  <a href={hero.data.cta.url}>{hero.data.cta.label}</a>
</section>

<ul>
  {features.map((f) => (
    <li>
      <h3>{f.data.name}</h3>
      {/* rich_text fields carry server-generated, sanitized HTML */}
      <div set:html={f.data.description.html} />
    </li>
  ))}
</ul>
```

## MCP server

A **stateless MCP server** at `POST /mcp` lets Claude (or any MCP client) model your content,
author and publish entries, and pull media in from a URL — over the same services the admin API
uses. Authenticate with a Bearer **API key** (Settings → API keys).

```bash
# Claude Code (native HTTP transport). Other clients: see the full guide below.
claude mcp add --transport http dito https://your-worker.workers.dev/mcp \
  --header "Authorization: Bearer dito_xxx"
```

Then ask Claude to, say, *"model a landing page with a hero, features and testimonials, and
fill it in with an image from this URL"* — it will create the collections, author entries,
and publish them. Revoking the key immediately `401`s the endpoint.

**→ Full MCP guide: [docs/mcp.md](docs/mcp.md)** — endpoint, auth, every client's config, the
tool catalog, and agent workflows. It's a standalone, public doc you can point an AI agent at to
discover and drive an instance **without giving it access to this repository**.

## Architecture

| Route | What | Auth |
|---|---|---|
| `/` + unmatched | Admin SPA (Workers Static Assets, SPA fallback) | — |
| `/api/auth/*` | Better Auth | public by design |
| `/api/setup/status`, `/api/health` | first-run check, health | public |
| `/api/admin/*` | Admin API | session cookie **or** Bearer API key |
| `/api/v1/*` | Delivery API (published content) | public, CORS `*` |
| `/media/:id/:filename` | Media — R2 bytes (Range, ETag, immutable), or 302 → Cloudinary | public |
| `/mcp` | MCP server | Bearer API key |

## Plan limits & notes

Dito is sized for landing-page workloads and runs comfortably on small plans, but a few
Cloudflare limits are worth knowing:

- **Password hashing (free tier):** Better Auth hashes passwords with scrypt, which can
  approach the free-tier 10 ms CPU limit on sign-in. **Workers Paid is recommended** for
  production.
- **API keys are not rate-limited.** Keys are admin-issued for trusted, high-volume callers
  (delivery sites, the MCP server, CI), so per-key rate limiting is disabled; Cloudflare's
  edge handles abuse/DDoS. Treat keys as secrets and revoke leaked ones.
- **Uploads:** images are capped at 25 MB (streamed directly); videos use multipart upload
  (10 MiB parts, up to 2 GB) to stay under the Worker request-body limit.
- **D1:** 500 MB database on the free plan; entry JSON ≤ 1 MB and rich text ≤ 256 KB per
  field. `json_extract` delivery filters are table scans — fine at landing-page scale.
- **Media URLs** use an unguessable id and are public regardless of entry status; the public
  delivery API serves published content only.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the development
setup, project conventions, and pull-request workflow. Please report security issues
privately via GitHub Security advisories rather than public issues.

## License

MIT — see [LICENSE](LICENSE).
