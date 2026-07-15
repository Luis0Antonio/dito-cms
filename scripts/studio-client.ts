/**
 * Open Drizzle Studio against ONE client's remote Cloudflare D1 — browse and edit the exact
 * rows that client's deployed Worker serves.
 *
 *   bun run studio-client acme
 *
 * The D1 database id is read from clients/acme.jsonc (`database_id`). Studio talks to D1 over
 * Cloudflare's HTTP API (drizzle-kit's `d1-http` driver, drizzle.config.remote.ts), which needs
 * two credentials wrangler's OAuth login can't provide:
 *
 *   • CLOUDFLARE_ACCOUNT_ID — pass `--account <id>` or set the env var (also read from .env).
 *   • CLOUDFLARE_D1_TOKEN   — a Cloudflare API token with "D1 : Edit"; set it in your shell
 *     env or .env (both gitignored). Create one at
 *     https://dash.cloudflare.com/profile/api-tokens → Custom token → Account · D1 · Edit.
 *     (CLOUDFLARE_API_TOKEN is accepted as a fallback.)
 *
 * ⚠ This is LIVE production data — edits in Studio write straight through. There is no local
 *   copy and no undo. For the local dev DB use `bun run db:studio` instead.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ROOT, client, clientDatabaseId, parseArgs, useAccount } from "./lib/fleet.ts";

const REMOTE_CONFIG = "drizzle.config.remote.ts";
const PLACEHOLDER_DB_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Load `KEY=value` lines from a repo-root `.env` into process.env WITHOUT overriding vars already
 * present — so a shell export (or `--account`, which sets CLOUDFLARE_ACCOUNT_ID) always wins over
 * .env. Keeps this script's credential validation consistent with what drizzle.config.remote.ts
 * reads at spawn time, instead of depending on drizzle-kit's own .env handling.
 */
function loadDotEnv(): void {
  const path = resolve(ROOT, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || m[1] in process.env) continue; // skip comments/blanks and don't clobber the shell
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value;
  }
}

function main(): void {
  const { positionals, accountId } = parseArgs(process.argv.slice(2));
  useAccount(accountId); // sets CLOUDFLARE_ACCOUNT_ID when --account is passed
  const c = client(positionals[0] ?? "");
  if (!existsSync(c.config)) {
    throw new Error(`No clients/${c.name}.jsonc — run \`bun run new-client ${c.name}\` first.`);
  }

  const databaseId = clientDatabaseId(c);
  if (databaseId === PLACEHOLDER_DB_ID) {
    throw new Error(
      `clients/${c.name}.jsonc still has the placeholder database_id — provision it with ` +
        `\`bun run new-client ${c.name}\` first.`,
    );
  }

  // .env fills any credentials not already in the shell; then pin the per-client id (it must win).
  loadDotEnv();
  process.env.CLOUDFLARE_DATABASE_ID = databaseId;

  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) {
    throw new Error(
      "Missing Cloudflare account id. Pass `--account <id>`, or set CLOUDFLARE_ACCOUNT_ID in your " +
        "shell env or .env. Find it in the Cloudflare dashboard URL or via `npx wrangler whoami`.",
    );
  }

  // The config reads CLOUDFLARE_D1_TOKEN; accept CLOUDFLARE_API_TOKEN too but normalize to that name.
  const token = process.env.CLOUDFLARE_D1_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    throw new Error(
      'Missing Cloudflare API token. Studio over d1-http needs a token with "D1 : Edit" — ' +
        "wrangler's OAuth login can't be reused. Set CLOUDFLARE_D1_TOKEN in your shell env or .env " +
        "(create one at https://dash.cloudflare.com/profile/api-tokens → Custom token → Account · D1 · Edit).",
    );
  }
  process.env.CLOUDFLARE_D1_TOKEN = token;

  console.warn(`→ Opening Drizzle Studio for ${c.worker} (remote D1 ${c.db})…`);
  console.warn(`  account: ${account}  database_id: ${databaseId}`);
  console.warn("  ⚠ This is LIVE production data — edits write through with no undo.");
  console.warn("  Press Ctrl-C to quit.\n");

  try {
    execFileSync("npx", ["drizzle-kit", "studio", "--config", REMOTE_CONFIG], {
      cwd: ROOT,
      stdio: "inherit",
    });
  } catch (error: unknown) {
    // Ctrl-C (SIGINT/SIGTERM) is the normal way to stop Studio — exit cleanly, not as a failure.
    const signal = (error as { signal?: string }).signal;
    if (signal === "SIGINT" || signal === "SIGTERM") return;
    throw error;
  }
}

try {
  main();
} catch (error: unknown) {
  console.error("\n✗ studio-client failed:", error instanceof Error ? error.message : error);
  process.exit(1);
}
