import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

// Cloudflare's local D1 (miniflare) stores the database as a SQLite file with a
// content-hashed name under .wrangler/state. Locate it so `drizzle-kit studio`
// (bun run db:studio) opens the same DB that `wrangler dev` and
// `db:migrate:local` use. Returns undefined until the local DB has been created
// (e.g. by running `bun dev` or `bun run db:migrate:local`).
function localD1Path(): string | undefined {
  const dir = resolve(".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  if (!existsSync(dir)) return undefined;
  const file = readdirSync(dir).find(
    (f) => f.endsWith(".sqlite") && f !== "metadata.sqlite",
  );
  return file ? resolve(dir, file) : undefined;
}

// SQLite dialect for Cloudflare D1. drizzle-kit only generates SQL here;
// `wrangler d1 migrations apply` is what actually runs them against D1.
export default defineConfig({
  dialect: "sqlite",
  schema: ["./src/worker/db/schema.ts", "./src/worker/db/auth-schema.ts"],
  out: "./migrations",
  // Only consumed by `drizzle-kit studio`; generate/migrate ignore it.
  dbCredentials: {
    url:
      localD1Path() ??
      ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/db.sqlite",
  },
});
