# CLAUDE.md

Guidance for AI agents (Claude Code) working in this repository. For the full user-facing
docs, see `README.md`.

Dito CMS is a **single-tenant**, self-hosted headless CMS: one Cloudflare Worker bundles the
admin SPA, the APIs, D1 (structured content), R2 (media), and an MCP server. One deploy serves
one client.

## Multi-client fleet tooling

Run this single clone as a fleet of isolated per-client deployments — Worker `dito-<name>`,
D1 `dito-<name>-db`, R2 `dito-<name>-media` — with no clone or GitHub repo per client. Shared
helpers live in `scripts/lib/fleet.ts`; the three entry points are:

| Command | Use it to | Creates infra? |
|---|---|---|
| `bun run new-client <name>` | Provision **and** deploy a **new** client | ✅ D1 + R2 |
| `bun run deploy-client <name>` | Redeploy **one existing** client (migrate + build + deploy) | ❌ must exist |
| `bun run deploy-all` | Redeploy **every** client in `clients/` (one shared build) | ❌ must exist |

All three accept `--account <id>` (or the `CLOUDFLARE_ACCOUNT_ID` env var) to target a Cloudflare
account when the login has more than one — required in non-interactive runs with multiple accounts.
`new-client` is idempotent: it reuses existing D1/R2, refreshes `clients/<name>.jsonc`, and redeploys.

### How it works — don't break these

- **Deploy reuses ONE `vite build`.** The `@cloudflare/vite-plugin` bakes the config into
  `dist/dito_cms/wrangler.json` at build time and writes a `.wrangler/deploy/config.json` redirect
  that a bare `wrangler deploy` follows. `deployClient()` patches that generated config's `name`
  and D1/R2 bindings per client, then runs bare `wrangler deploy`. The worker JS is client-agnostic
  (identity comes from bindings), so one build serves every client.
- **Never `wrangler deploy -c clients/<name>.jsonc`.** Passing `-c` bypasses the vite build and
  mis-resolves `main`/assets relative to `clients/`. Deploy only through the fleet scripts.
- **`clients/<name>.jsonc` is used ONLY for migrations, not deploy.** Its `migrations_dir` is
  `"../migrations"` because wrangler resolves config paths relative to the config file, so it must
  climb out of `clients/`. Deploy-affecting settings — custom-domain `routes`, `workers_dev`,
  `preview_urls` — belong in the base `wrangler.jsonc`, **not** the client config, where they have
  no effect.
- **Keep the base `wrangler.jsonc` pristine** — a single `MEDIA` R2 binding, the base `dito-cms*`
  names, and the placeholder `database_id`. `new-client` copies the base into each client config,
  so any stray edit (e.g. a client-specific R2 binding written back by the Cloudflare dashboard)
  contaminates every future client. Note that `setKey` rewrites only the *first* `bucket_name`, so a
  multi-entry base leaks silently.

### Notes

- Client configs hold only resource identifiers (worker/db/bucket names + `database_id`) — **no
  secrets**. Real secrets (`BETTER_AUTH_SECRET`, `CLOUDINARY_URL`) live in Cloudflare's secret store;
  set per client with `wrangler secret put <NAME> -c clients/<name>.jsonc`. A `database_id` is inert
  without account auth, so these configs can be regenerated from the account (`wrangler d1 list`).
- Fresh clones lack the gitignored `worker-configuration.d.ts`; run `bun run cf-typegen` before the
  worker typecheck (`tsc -p tsconfig.worker.json`) will pass.
- Full walkthrough (custom domains, offboarding) is in README → **Managing multiple clients**.
