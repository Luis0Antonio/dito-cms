# Client fleet configs

One `clients/<name>.jsonc` per deployed client — a copy of the repo-root `wrangler.jsonc`
with the Worker `name`, D1 `database_name` / `database_id`, and R2 `bucket_name` swapped for
that client. Binding names stay `DB` / `MEDIA`, so no application code changes per client.

**These files are committed on purpose.** They hold no secrets — only Cloudflare resource
ids — and they are the source of truth for who is deployed (your fleet, without a GitHub repo
per client).

Managed by the fleet scripts — you rarely edit them by hand:

```bash
bun run new-client <name>     # provision D1 + R2, write this config, migrate, deploy
bun run deploy-client <name>  # redeploy one client (migrate + build + deploy)
bun run deploy-all            # build once, then migrate + redeploy every client here
```

See the repo README, section **"Managing multiple clients"**, for the full workflow.

> `migrations_dir` here is `"../migrations"` (not `"migrations"`): wrangler resolves config
> paths relative to the config file, so from `clients/` it must climb back to the repo-root
> `migrations/` folder. The generator sets this for you.
