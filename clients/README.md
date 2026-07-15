# Client fleet configs

One `clients/<name>.jsonc` per deployed client — a copy of the repo-root `wrangler.jsonc`
with the Worker `name`, D1 `database_name` / `database_id`, and R2 `bucket_name` swapped for
that client. Binding names stay `DB` / `MEDIA`, so no application code changes per client.

**These files are gitignored** (the `clients/` directory is kept out of the repo). They hold no
secrets — only Cloudflare resource ids — and are the local source of truth for who is deployed
(your fleet, without a GitHub repo per client); a lost config can be regenerated from the account
(`wrangler d1 list`), since a `database_id` is inert without account auth.

**A client's media provider is recorded here:** an `r2_buckets` block means Cloudflare R2; its
**absence** means Cloudinary (`bun run new-client <name> --cloudinary`), whose media identity is a
per-client `CLOUDINARY_URL` secret instead of a bucket. The fleet scripts read that presence/absence
to deploy each client on the right backend.

Managed by the fleet scripts — you rarely edit them by hand:

```bash
bun run new-client <name>     # provision D1 (+ R2 unless --cloudinary), write this config, migrate, deploy
bun run deploy-client <name>  # redeploy one client (migrate + build + deploy)
bun run deploy-all            # build once, then migrate + redeploy every client here
bun run studio-client <name>  # open Drizzle Studio on this client's remote D1 (needs a D1:Edit API token)
```

See the repo README, section **"Managing multiple clients"**, for the full workflow.

> `migrations_dir` here is `"../migrations"` (not `"migrations"`): wrangler resolves config
> paths relative to the config file, so from `clients/` it must climb back to the repo-root
> `migrations/` folder. The generator sets this for you.
