import { defineConfig } from "drizzle-kit";

// Remote Cloudflare D1 over the HTTP API. Used ONLY by `bun run studio-client <name>`
// to open Drizzle Studio against ONE client's LIVE remote database — the same rows the
// deployed Worker serves. Editing here writes straight to production; there is no undo.
//
// All three credentials come from the environment — this file holds NO secrets:
//   • CLOUDFLARE_DATABASE_ID — set by studio-client from clients/<name>.jsonc's database_id
//   • CLOUDFLARE_ACCOUNT_ID  — your Cloudflare account (studio-client's --account, or the env var)
//   • CLOUDFLARE_D1_TOKEN    — a Cloudflare API token with "D1 : Edit" (shell env or .env)
//
// The local miniflare DB stays in drizzle.config.ts (`bun run db:studio`); this file never
// touches it. The `!` assertions are safe because studio-client validates all three first.
export default defineConfig({
  dialect: "sqlite",
  driver: "d1-http",
  schema: ["./src/worker/db/schema.ts", "./src/worker/db/auth-schema.ts"],
  out: "./migrations",
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    databaseId: process.env.CLOUDFLARE_DATABASE_ID!,
    token: process.env.CLOUDFLARE_D1_TOKEN!,
  },
});
