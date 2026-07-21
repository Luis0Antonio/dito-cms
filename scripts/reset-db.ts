/**
 * Empty every table in the LOCAL D1 database, leaving the schema intact.
 *
 *   bun run db:reset:local
 *
 * Wipes all rows from the local (miniflare) D1 database that `wrangler dev` and
 * `bun run db:migrate:local` use — the same file `bun run db:studio` opens.
 * The schema is left untouched, so this is a data-only reset: every table is
 * left empty and ready to re-seed. The `d1_migrations` bookkeeping table is
 * preserved so `db:migrate:local` stays a no-op afterwards.
 *
 * Stop `wrangler dev` before running — both processes write the same SQLite file.
 * Re-seed afterwards with `DITO_API_KEY=… bun run seed`.
 */
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";

// Bookkeeping tables to keep, so the DB stays in a consistent "migrated but
// empty" state: `d1_migrations` (drizzle/wrangler migration log) and D1's own
// internal tables, which Cloudflare prefixes with `_cf_` (e.g. _cf_METADATA).
const PRESERVE = new Set(["d1_migrations"]);
const isAppData = (name: string): boolean =>
  !PRESERVE.has(name) && !name.startsWith("_cf_");

/** Absolute path to the local miniflare D1 SQLite file, or undefined if none exists yet. */
function findLocalD1(): string | undefined {
  const dir = resolve(".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  if (!existsSync(dir)) return undefined;
  const file = readdirSync(dir).find(
    (f) => f.endsWith(".sqlite") && f !== "metadata.sqlite",
  );
  return file ? resolve(dir, file) : undefined;
}

function main(): void {
  const path = findLocalD1();
  if (!path) {
    console.error(
      "✗ No local D1 database found. Run `bun dev` or `bun run db:migrate:local` first.",
    );
    process.exit(1);
  }

  const db = new Database(path);
  try {
    // Defer FK checks: every table ends up empty, so order doesn't matter.
    db.pragma("foreign_keys = OFF");

    const all = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string }[];
    const tables = all.filter((t) => isAppData(t.name));
    const preserved = all.filter((t) => !isAppData(t.name)).map((t) => t.name);

    if (tables.length === 0) {
      console.warn("• Nothing to clear — no data tables found.");
      return;
    }

    const hasSequence = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
      )
      .get();

    db.transaction(() => {
      for (const { name } of tables) {
        db.prepare(`DELETE FROM "${name.replace(/"/g, '""')}"`).run();
      }
      // Reset AUTOINCREMENT counters so ids restart from 1.
      if (hasSequence) db.prepare("DELETE FROM sqlite_sequence").run();
    })();

    console.warn(`✓ Reset local D1 — emptied ${tables.length} table(s):`);
    for (const { name } of tables) console.warn(`    • ${name}`);
    if (preserved.length > 0) {
      console.warn(`  preserved bookkeeping: ${preserved.join(", ")}`);
    }
  } catch (error: unknown) {
    console.error(
      "\n✗ Reset failed:",
      error instanceof Error ? error.message : error,
    );
    console.error("  Is `wrangler dev` running? Stop it and try again.");
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
