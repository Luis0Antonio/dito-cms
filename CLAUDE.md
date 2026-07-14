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

## Relationships between schemas (the `reference` field type)

Entries link to other entries through the `reference` field type — the media (`picture`/`video`)
pattern pointed at `entries`. Preserve this design; do **not** regress it:

- **A reference stores the target entry's id in the entry JSON** (`draft_data`/`published_data`),
  keyed by field name — a bare id string, or an ordered `id[]` when `options.multiple`. Never a
  name/slug string, and **never a relational join table.** The reason is the draft/publish snapshot:
  a reference inside the JSON snapshots, reverts (`discardDraft`), and publishes atomically with the
  rest of the entry for free; a join table would need its own draft/published state per edge,
  doubling the `services/entries.ts` state machine.
- **Options:** `targetCollections` (allowed target collection slugs; `[]`/`["*"]` = any/polymorphic)
  and `multiple`. Flipping `multiple` reshapes stored values, so it's a **destructive** change gated
  by `allowDestructive` in `setFields` (like a type change).
- **Write-time integrity** is `assertEntryRefs` (`services/references.ts`), called next to
  `assertMediaRefs` in create/update/publish — batched existence + target-collection check. A
  **required** reference to an unpublished target is **blocked at publish** (else it would deliver
  `null`). zod only checks the value *shape*; existence needs a DB read, exactly like media.
- **Delivery** expands each reference via `expandReferences` (`services/delivery.ts`) into
  `{ id, slug, title, collection }` (or `null` if the target is deleted/unpublished) — one level deep
  in v1. `title` comes from the target's **published** data. Because expansion embeds another
  collection's data, each referenced collection's `contentVersion`/`updatedAt` is folded into the
  referrer's delivery **ETags** (`referencedVersionSignature`) so a rename never serves a stale 304.
- **Deletion is SET-NULL-like:** there is no DB cascade (it's JSON); a dangling id simply resolves to
  `null` at delivery, with a pre-delete usage warning (`getEntryUsage`, `LIKE '%"<id>"%'` scan) surfaced
  in the delete dialog, the `GET /entries/:id/usage` route, and `delete_entry`'s `referencedBy`.
- **Export/import preserves references** (bundle `version: 2`): each exported entry carries its `id`,
  and `applyImport` runs a **global two-pass** — insert every collection's entries building an
  `oldId→newId` map, then `remapImportedReferences` rewrites reference values through it. Import re-mints
  ids, so a single pass would break A→B when B lands after A. A reference into a *skipped* collection has
  no new id and stays a dangling source id (→ `null`), counted as `unresolvedReferences`. v1 bundles are
  still accepted but their references don't carry over. Don't collapse this back to a per-collection loop.
- **Legacy string→reference migration** is `migrateStringFieldToReference` (`services/references.ts`),
  exposed as `POST /api/admin/collections/:slug/migrate-reference` and the `migrate_string_field_to_reference`
  MCP tool. It matches each entry's old name-string (trimmed, case-insensitive) against the target
  collection's **title**, writes the resolved id into the new reference field in **both** draft and
  published JSON directly (no re-publish — safe by construction, so `assertEntryRefs` is bypassed) and
  recomputes `published_etag` + bumps `contentVersion` when a live row moves. An **ambiguous** title
  (shared by 2+ targets) is reported, never auto-resolved; the caller fixes `unmatched`/`ambiguous` by
  hand, then drops the old field with `setFields(allowDestructive)`. Because it writes JSON directly it
  **bypasses the publish-readiness block** (`assertEntryRefs` isn't run) — a *required* ref backfilled
  onto an unpublished target delivers `null` until that target is published, so publish targets first.
  Don't reintroduce name matching as the *runtime* link — this tool is a one-time backfill onto the
  id-based design.
- `reference` is **not** enabled on product custom fields — `product_fields`' CHECK is left unwidened
  and `setProductFields`/`normalizeField` rejects it explicitly.

## Storage limit + System Admin role

A per-deployment media **storage cap** (default 5 GB, `DEFAULT_STORAGE_LIMIT_GB`) blocks uploads once
stored media would exceed it, so an R2 client can't silently run up the vendor's Cloudflare bill.
Preserve this design; do **not** regress it:

- **System Admin is a D1-only allowlist, NOT the `user.role` column.** Membership lives solely in the
  `settings` row `system_admin_user_ids` (comma-separated user ids); `isSystemAdmin` (`services/roles.ts`)
  reads *only* that row. No route writes an arbitrary settings key (every `setSetting` call passes a
  fixed literal key), so the allowlist is unreachable through the UI/API — grantable **only** by a direct
  D1 write (`INSERT … INTO settings ('system_admin_user_ids', <userId>) …`). This is deliberate: a regular
  admin *can* call better-auth's `admin.setRole` and even write `role='system_admin'`, but that column is
  never consulted, so it grants nothing. **Never gate on `user.role`, never add a hook/`adminRoles` entry
  for it, and never expose a route that writes `system_admin_user_ids`** — any of these re-opens escalation.
- **The limit is a `settings` value (`storage_limit_gb`), not a migration.** Default is in code, so
  enforcement is live on every deployment immediately. `setStorageLimitGb` validates finite / >0 / ≤1024.
- **Enforcement is a soft guard in the media *service* layer** (`services/media.ts`) — the one choke point
  covering both the SPA and the MCP `upload_media_from_url` tool. Four checkpoints (`uploadImage`,
  `uploadMediaFromUrl`, `initVideoUpload`, `completeVideoUpload`) reject with **507** `storage_limit_exceeded`
  (not 413 — proxies special-case it). Concurrent uploads can race past the `SUM(size)` check; acceptable.
  `completeVideoUpload` subtracts the in-flight row's already-counted declared `size` before re-checking
  the real assembled bytes (a client under-declaring at init could otherwise overshoot). Delete frees bytes
  for free — usage is `SUM(size)` over `media`, so a removed row self-corrects; no counter to maintain.
- **Usage + limit are read-only to every admin; only a System Admin PATCHes the limit** (field-level gate
  in `admin-settings.ts` — other settings fields stay open). The GET payload's `canEditStorageLimit` only
  toggles the editable input; the server re-checks on PATCH → 403. A usage bar on the Media page is the
  surface the blocked-upload toast points to; keep it fresh by invalidating `settingsKeys.all` on upload
  success and media delete.
