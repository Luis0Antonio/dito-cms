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
  (exactly one) with seven field types in a drag-and-drop schema builder.
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

### Store secret encryption (commerce module)

Optional, and only relevant when the commerce module is enabled and you configure payments.
Payment-provider secrets (the Culqi secret key) and the order-hook auth header are stored
**encrypted** (AES-256-GCM) in the D1 `settings` table, keyed by `SETTINGS_ENC_KEY` — a 32-byte
key, standard-base64-encoded. Generate one with `openssl rand -base64 32`. For a deployed Worker:
`wrangler secret put SETTINGS_ENC_KEY`; for local dev, add it to `.dev.vars`. It is required only
when saving or using those secrets — content-only and catalog-only instances never need it, and
the Worker never touches the key at boot.

## Content model & authoring

Define **collections** (many entries) and **singletons** (exactly one entry) in the schema
builder. Each has **fields** of seven types: text, rich text, number, boolean, picture,
video and link. Authoring is **draft → publish**: edits are saved as drafts, and the
delivery API only ever serves the last published version. Required fields and bounds are
enforced at publish time, not while drafting.

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

A **stateless MCP server** at `POST /mcp` lets Claude (or any MCP client) model your content
and manage entries — including pulling images into the media library from a URL. It exposes
16 tools over the same services the admin API uses: `get_cms_info`, `list_collections`,
`get_collection`, `create_collection`, `update_collection`, `set_collection_fields`,
`delete_collection`, `list_entries`, `get_entry`, `create_entry`, `update_entry`,
`publish_entry`, `unpublish_entry`, `delete_entry`, `list_media`, and `upload_media_from_url`.

Authenticate with a Bearer **API key** (Settings → API keys).

**Claude Code** (supports custom headers):

```bash
claude mcp add --transport http dito https://your-worker.workers.dev/mcp \
  --header "Authorization: Bearer dito_xxx"
```

**Claude Desktop** (its connector UI can't send custom headers — bridge with `mcp-remote`):

```bash
npx mcp-remote https://your-worker.workers.dev/mcp --header "Authorization: Bearer dito_xxx"
```

Then ask Claude to, say, *"model a landing page with a hero, features and testimonials, and
fill it in with an image from this URL"* — it will create the collections, author entries,
and publish them. Revoking the key immediately `401`s the endpoint.

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
